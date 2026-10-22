/** Conservative interpreters for the complete eligibility bullets extracted by discovery.
 * Unmatched text is retained for the qualitative stage, never silently discarded.
 */
const { normaliseEmploymentStatus } = require('./facts');
const cache = new Map();
const clean = value => String(value ?? '').toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
const numeric = value => value == null || value === '' || typeof value === 'boolean' || !Number.isFinite(Number(value)) ? null : Number(value);
const range = (field,min,max,label,extra={}) => ({type:'range',field,min,max,label,...extra});
const member = (field,allowed,label) => ({type:'member',field,allowed,label});
const all = rules => ({type:'all',rules});
const any = rules => ({type:'any',rules});
function fieldsOf(rule) { return rule.rules ? rule.rules.flatMap(fieldsOf) : rule.type === 'regional_income' ? ['monthly_income','state'] : rule.type === 'maturity_age' ? ['age','requested_tenure_months'] : [rule.field]; }
function scopeOf(line) {
  let scope=null,text=line,match;
  if ((match=text.match(/^(?:if |for )(salaried|self[- ]employed)\s*[,]?\s+/)) || (match=text.match(/^(salaried|self[- ]employed)\s*-\s*/))) { scope=normaliseEmploymentStatus(match[1]);text=text.slice(match[0].length); }
  if ((match=text.match(/\s+for (salaried|self[- ]employed)$/))) { scope=normaliseEmploymentStatus(match[1]);text=text.slice(0,-match[0].length); }
  if ((match=text.match(/^age limit for (salaried|self[- ]employed)\s*-\s*/))) { scope=normaliseEmploymentStatus(match[1]);text='age '+text.slice(match[0].length); }
  return {scope,text};
}
function compileLine(source) {
  if (cache.has(source)) return cache.get(source);
  const {scope,text}=scopeOf(clean(source)); let match,rule=null;
  // Anchored forms preserve strict < and > boundaries and employment scopes.
  if ((match=text.match(/^(?:age\s*-?\s*)?at least (\d{1,2})(?: years(?: old)?)? and (less than|no older than) (\d{1,2})(?: years(?: old)?)?$/))) {
    rule=range('age',+match[1],+match[3],'Age',{maxExclusive:match[2]==='less than'});
  } else if ((match=text.match(/^(?:age(?: limit)?\s*-?\s*)(\d{1,2})(?: years)?\s*(?:-|to)\s*(\d{1,2})(?: years(?: old)?)?( at the time of loan maturity)?$/))) {
    rule=match[3] ? {type:'maturity_age',min:+match[1],max:+match[2]} : range('age',+match[1],+match[2],'Age');
  } else if ((match=text.match(/^minimum age\s*-?\s*(\d{1,2}) years; maximum age\s*-?\s*(\d{1,2}) years$/))) {
    rule=range('age',+match[1],+match[2],'Age');
  } else if ((match=text.match(/^applicant should be earning at least ₹\s*([\d,]+) per month as net income \(₹\s*([\d,]+) for applicants from (.+)\)$/))) {
    rule={type:'regional_income',base:+match[1].replace(/,/g,''),regional:+match[2].replace(/,/g,''),state:clean(match[3])};
  } else if ((match=text.match(/^(?:minimum net monthly income that is not less than|minimum (?:monthly )?income(?: of)?|salaried individuals with minimum net monthly income of|the person must have a monthly income of|monthly income should be (more than|at least))\s*(?:₹|rs\.?|inr)\s*([\d,]+)(?: and above)?$/))) {
    rule=range('monthly_income',+match[2].replace(/,/g,''),null,'Monthly income',{minExclusive:match[1]==='more than'});
  } else if ((match=text.match(/^minimum (\d+(?:\.\d+)?) years? of total work experience or minimum (\d+(?:\.\d+)?) years? with current company$/))) {
    rule=any([range('employment_years',+match[1],null,'Total work experience'),range('current_employer_years',+match[2],null,'Time with current employer')]);
  } else if ((match=text.match(/^(\d+(?:\.\d+)?) years? minimum overall work experience with (\d+(?:\.\d+)?) years? minimum experience in current company$/))) {
    rule=all([range('employment_years',+match[1],null,'Total work experience'),range('current_employer_years',+match[2],null,'Time with current employer')]);
  } else if ((match=text.match(/^at least (\d+(?:\.\d+)?) years? of experience after relevant qualification$/))) {
    rule=range('post_qualification_years',+match[1],null,'Experience after qualification');
  } else if ((match=text.match(/^minimum (\d+(?:\.\d+)?) years? overall experience is required$/))) {
    rule=range('employment_years',+match[1],null,'Total work experience');
  } else if ((match=text.match(/^business must have been in existence for a minimum of (\d+) years and its profit after tax \(pat\) for the last (\d+) years should be positive$/)) && +match[2]===2) {
    rule=all([range('business_years',+match[1],null,'Business operating history'),{type:'positive_profits',field:'profit_after_tax_last_two_years',label:'Positive profit after tax in both of the last two years'}]);
  } else if ((match=text.match(/^applicants should be currently employed, with at least (\d+(?:\.\d+)?) years? with their current employer$/))) {
    rule=all([member('employment_status',['Salaried','Self-Employed'],'Currently employed'),range('current_employer_years',+match[1],null,'Time with current employer')]);
  } else if ((match=text.match(/^(?:cities\s*:\s*|sourcable location will )([a-z ,&]+)$/))) {
    rule=member('city',match[1].split(/,|&|\band\b/).map(clean).filter(Boolean),'Serviceable city');
  } else if (text==='applicants must be salaried indian residents working at mncs, public companies or other large private organisations') {
    rule=all([member('employment_status',['Salaried'],'Salaried employment'),member('residency_country',['india','in','indian'],'Indian residency'),member('employer_category',['mnc','multinational','multinational company','public company','large private organisation','large private organization','large private company'],'Employer category')]);
  } else if ((match=text.match(/^the applicant will have to be a permanent employees? of (.+)$/))) {
    rule=all([member('employment_status',['Salaried'],'Salaried employment'),member('employment_type',['permanent'],'Permanent employment'),member('employer_group',[match[1]],'Required employer group')]);
  }
  const result=rule ? {scope,rule,fields:fieldsOf(rule),source} : null;
  if(cache.size>256)cache.clear(); cache.set(source,result); return result;
}
function normaliseFact(field,value) {
  let text=clean(value);
  if(field==='employment_status')return normaliseEmploymentStatus(value);
  if(field==='city' && ['banglore','bangalore','bengaluru'].includes(text))text='bengaluru';
  if(field==='state' && text==='mp')text='madhya pradesh';
  return text;
}
function result(rule,state,detail,extra={}) { return {code:`POLICY_${String(rule.field || rule.type).toUpperCase()}_${state.toUpperCase()}`,state,detail,fields:fieldsOf(rule),...extra}; }
function evaluateRule(rule,user) {
  if(rule.type==='all'||rule.type==='any') {
    const children=rule.rules.map(child=>evaluateRule(child,user));
    const state=rule.type==='all' ? children.some(c=>c.state==='fail')?'fail':children.some(c=>c.state==='unknown')?'unknown':'pass'
      : children.some(c=>c.state==='pass')?'pass':children.every(c=>c.state==='fail')?'fail':'unknown';
    return result(rule,state,children.map(child=>child.detail).join(rule.type==='any'?' OR ':' AND '),{children});
  }
  if(rule.type==='regional_income') {
    const income=numeric(user.monthly_income),state=normaliseFact('state',user.state);
    if(income===null)return result(rule,'unknown','Monthly income is required');
    if(income<Math.min(rule.base,rule.regional))return result(rule,'fail','Monthly income is below both regional thresholds');
    if(income>=Math.max(rule.base,rule.regional))return result(rule,'pass','Monthly income satisfies both regional thresholds');
    if(!state||state==='unknown')return result(rule,'unknown',`State is required to select the ${rule.base} or ${rule.regional} monthly income requirement`);
    return result(rule,income>=(state===rule.state?rule.regional:rule.base)?'pass':'fail','State-specific monthly income requirement',{value:income});
  }
  if(rule.type==='maturity_age') {
    const age=numeric(user.age),tenure=numeric(user.requested_tenure_months);
    if(age!==null&&age>rule.max)return result(rule,'fail','Current age already exceeds the maximum age at maturity');
    if(age===null||tenure===null||tenure<=0)return result(rule,'unknown','Applicant age and positive requested tenure are required to check age at loan maturity');
    const maturity=age+tenure/12;
    return result(rule,maturity>=rule.min&&maturity<=rule.max?'pass':'fail',`Age at maturity ${maturity.toFixed(2)} must be between ${rule.min} and ${rule.max}`);
  }
  const value=user[rule.field];
  if(rule.type==='member') {
    if(value==null||value===''||clean(value)==='unknown')return result(rule,'unknown',`${rule.label} is required but not supplied`);
    const pass=rule.allowed.some(allowed=>normaliseFact(rule.field,allowed)===normaliseFact(rule.field,value));
    return result(rule,pass?'pass':'fail',`${rule.label}: ${value}; accepted: ${rule.allowed.join(', ')}`);
  }
  if(rule.type==='positive_profits') {
    if(Array.isArray(value)&&value.some(v=>numeric(v)!==null&&Number(v)<=0))return result(rule,'fail','Profit after tax must be positive in each of the last two years');
    if(!Array.isArray(value)||value.length!==2||value.some(v=>numeric(v)===null))return result(rule,'unknown','Profit after tax for both of the last two years is required');
    return result(rule,value.every(v=>Number(v)>0)?'pass':'fail','Profit after tax must be positive in each of the last two years');
  }
  const number=numeric(value);
  if(number===null)return result(rule,'unknown',`${rule.label} is required but not supplied`);
  const pass=(rule.min==null||(rule.minExclusive?number>rule.min:number>=rule.min)) && (rule.max==null||(rule.maxExclusive?number<rule.max:number<=rule.max));
  return result(rule,pass?'pass':'fail',`${rule.label} ${number} ${pass?'satisfies':'does not satisfy'} ${rule.minExclusive?'>':'>='}${rule.min??'unpublished'}${rule.max==null?'':` and ${rule.maxExclusive?'<':'<='}${rule.max}`}`,{value:number,requirement:{min:rule.min,max:rule.max,minExclusive:!!rule.minExclusive,maxExclusive:!!rule.maxExclusive}});
}
function evaluatePolicy(user,product) {
  const lines=Array.isArray(product.criteria?.eligibility_lines)?product.criteria.eligibility_lines:[];
  const checks=[],unresolved=[],handled=new Set();
  for(const source of lines.filter(line=>typeof line==='string'&&line.trim())) {
    const compiled=compileLine(source);
    if(!compiled){const scope=scopeOf(clean(source)).scope;if(!scope||scope===normaliseEmploymentStatus(user.employment_status))unresolved.push(source);continue;}
    compiled.fields.forEach(field=>handled.add(field));
    if(compiled.scope && compiled.scope!==normaliseEmploymentStatus(user.employment_status))continue;
    checks.push({...evaluateRule(compiled.rule,user),source});
  }
  return {checks,unresolved,handled};
}
module.exports={compileLine,evaluatePolicy,evaluateRule,fieldsOf};
