/** Upload monitor: batches are filtered by decision lane, never by missing matches. */
const $ = selector => document.querySelector(selector);
const state = { uploadId: null, timer: null, lane: 'rules', batches: [], upload: {}, selectedBatch: null,
  offset: 0, search: '', detailSequence: 0, lastDetailRefresh: 0, polling: false };
const names = { eligible: 'Eligible', ineligible: 'Not eligible', review: 'Needs review', pending: 'Pending',
  completed: 'Completed', qualitative: 'Processing', processing: 'Processing', sending: 'Sending notifications',
  sent: 'Sent', failed: 'Failed', rejected: 'Rejected', not_sent: 'Not sent', not_recorded: 'Not recorded',
  queued: 'Queued', history: 'Recorded results' };
const number = value => Number(value || 0).toLocaleString('en-IN');
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function badge(status, working = false) {
  const safe = Object.hasOwn(names, status) ? status : 'pending';
  return `<span class="badge ${safe}${working ? ' working' : ''}">${names[safe]}</span>`;
}
function setMessage(text, kind) { $('#message').textContent = text; $('#message').className = `message ${kind || ''}`; }
function formatRate(min, max) { return min == null ? 'Not published' : max == null ? `${Number(min)}% onwards` : Number(min) === Number(max) ? `${Number(min)}% p.a.` : `${Number(min)}% – ${Number(max)}%`; }
function formatAmount(value) { return value == null ? 'Not published' : `₹${Math.round(Number(value)).toLocaleString('en-IN')}`; }
function formatTenure(min, max) { const years = months => `${Math.round(months / 12 * 10) / 10} years`; return min == null ? 'Not published' : max == null || min === max ? years(min) : `${years(min)} – ${years(max)}`; }
function isHistorical(batch) { return !batch.matching_started_at && Object.values(batch.lanes || {}).some(lane => lane.recorded === false); }
function batchComplete(batch) { return batch.matching_status === 'completed' && Boolean(batch.notifications_completed_at); }
function overallStatus(upload, batches) {
  if (['failed','rejected'].includes(upload.status)) return upload.status;
  if (batches.length && batches.every(isHistorical)) return 'history';
  if (upload.status !== 'completed') return upload.status === 'processing' ? 'processing' : 'queued';
  if (!batches.length || batches.some(batch => batch.matching_status !== 'completed')) return 'processing';
  return batches.some(batch => !batch.notifications_completed_at) ? 'sending' : 'completed';
}
function showFile() { const file = $('#file').files[0]; $('#file-name').textContent = file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB` : 'Your file stays selected until you start.'; }
async function submit(event) {
  event.preventDefault(); const file = $('#file').files[0];
  if (!file) return setMessage('Choose a CSV file first.', 'error');
  const button = $('#submit'); button.disabled = true; setMessage('Uploading your applicants…');
  const body = new FormData(); body.append('file', file);
  try {
    const response = await fetch('/api/uploads', { method: 'POST', body }); const answer = await response.json();
    if (!response.ok) throw Error(typeof answer.detail === 'string' ? answer.detail : 'The upload was refused.');
    openUpload(answer.upload_id); loadRecent();
  } catch (error) { setMessage(error.message, 'error'); }
  finally { button.disabled = false; }
}
function closeDetails() { state.selectedBatch = null; state.detailSequence++; $('#applicant-card').hidden = true; }
function openUpload(id) {
  if (!id) return;
  clearInterval(state.timer); closeDetails(); state.uploadId = id; state.batches = []; state.offset = 0;
  $('#recent-uploads').value = id;
  try { localStorage.setItem('loan-upload-id', id); } catch { /* Storage is optional. */ }
  $('#status-card').hidden = false; $('#matches-card').hidden = true;
  setMessage('Loading the upload…'); state.timer = setInterval(poll, 2500); poll();
}
async function poll() {
  if (state.polling) return;
  state.polling = true; const id = state.uploadId;
  try {
    const response = await fetch(`/api/uploads/${id}?summary_only=true`);
    if (!response.ok) throw Error('The upload could not be read. Choose a recent upload to try again.');
    const answer = await response.json(); if (id !== state.uploadId) return;
    const upload = answer.upload || {}; const batches = answer.batches || [];
    const recent = $('#recent-uploads');
    if (recent.options && !Array.from(recent.options).some(option => option.value === id)) {
      const option = document.createElement('option'); option.value = id; option.textContent = upload.filename || id;
      recent.append(option);
    }
    recent.value = id;
    state.upload = upload; state.batches = batches; state.decisionCounts = answer.decision_counts; renderStatus(upload, batches); renderMatches(batches);
    const matches = batches.reduce((sum, batch) => sum + Number(batch.matches || 0), 0);
    const ready = batches.length > 0 && batches.every(batchComplete);
    if (upload.status === 'completed' && ready) {
      clearInterval(state.timer); state.timer = null;
      setMessage(`done: ${upload.accepted_rows} applicants in ${batches.length} batch(es), ${number(matches)} matches. Notification processing is complete.`, 'ok');
    } else if (overallStatus(upload, batches) === 'history') {
      clearInterval(state.timer); state.timer = null; setMessage('Showing recorded results from an earlier run. Detailed rejections may not be available.');
    } else if (['failed','rejected'].includes(upload.status)) {
      clearInterval(state.timer); state.timer = null; setMessage(upload.error || 'The upload could not be processed.', 'error');
    } else if (batches.some(batch => batch.fast_completed_at)) {
      const done = batches.filter(batch => batch.matching_status === 'completed').length;
      setMessage(`Processing: ${done}/${batches.length} batches completed.`);
    } else { setMessage(`Upload ${upload.filename || ''} is queued or loading. Results will appear here automatically.`); }

  } catch (error) { if (id === state.uploadId) setMessage(error.message, 'error'); }
  finally { state.polling = false; }
}
function renderStatus(upload, batches) {
  const status = overallStatus(upload, batches); const total = batches.length;
  const completed = batches.filter(batchComplete).length;
  $('#metrics').hidden = status !== 'completed';
  const matching = batches.filter(batch => batch.matching_status === 'completed').length;
  const notified = batches.filter(batch => batch.notifications_completed_at).length;
  const sent = batches.reduce((sum, batch) => sum + Number(batch.notifications_sent || 0), 0);
  const failed = batches.reduce((sum, batch) => sum + Number(batch.notifications_failed || 0), 0);
  const dispatchErrors = batches.filter(batch => batch.dispatch_error).map(batch => batch.dispatch_error);
  const history = status === 'history'; const failedRun = ['failed','rejected'].includes(status);
  const loading = upload.status !== 'completed';
  const steps = [
    ['Upload','File received', Boolean(upload.upload_id || total)],
    ['Load applicants', `${number(upload.accepted_rows)} loaded`, !loading],
    ['Check eligibility', `${matching} / ${total} batches`, total > 0 && matching === total],
    ['Notify', history ? 'Recorded history' : `${notified} / ${total} batches`, total > 0 && notified === total],
  ];
  const active = steps.findIndex(step => !step[2]);
  $('#pipeline').innerHTML = steps.map(([title, detail, done], index) => `<li class="${done ? 'done' : !failedRun && !history && index === active ? 'active' : ''}" ${index === active ? 'aria-current="step"' : ''}><span class="step-number">${done ? '✓' : index + 1}</span><span><span class="step-label">${title}</span><span class="step-description">${escapeHtml(detail)}</span></span></li>`).join('');
  $('#run-state').innerHTML = badge(status, ['queued','processing','sending'].includes(status));
  $('#progress-label').textContent = history ? 'Historical results available' : failedRun ? 'Processing stopped' : status === 'completed' ? 'All stages complete' : 'Batches with notification processing complete';
  $('#progress-value').textContent = `${completed} / ${total} batches`;
  const percent = total ? Math.round(completed / total * 100) : 0;
  $('#progress-fill').style.width = `${percent}%`; $('#run-progress').setAttribute('aria-valuenow', percent);
  const matches = batches.reduce((sum, batch) => sum + Number(batch.matches || 0), 0);
  const emails = batches.reduce((sum, batch) => sum + Number(batch.notifications || 0), 0);
  $('#metrics').innerHTML = [['Applicants loaded',upload.accepted_rows],['Confirmed matches',matches],['Batches matched',`${matching} / ${total}`],['Emails sent',sent],['Emails failed',failed],['Notifications recorded',emails]].map(([label,value]) => `<div class="metric"><span>${label}</span><strong>${number(value)}</strong></div>`).join('');
  const statusText = status === 'processing' ? 'processing matches' : status === 'sending' ? 'sending notifications' : names[status] || status;
  const dispatchRows = [
    ['Status',statusText],
    ['File',upload.filename || '—'],
    ['Rejected rows',upload.rejected_rows || 0],
    ['Matching',`${matching} / ${total} batches`],
    ['Emails',`${sent} sent${failed ? `, ${failed} failed` : ''}`],
  ];
  if (dispatchErrors.length) dispatchRows.push(['Dispatch error',dispatchErrors[0]]);
  $('#status').innerHTML = dispatchRows.map(([key,value]) => `<dt>${key}</dt><dd>${escapeHtml(value)}</dd>`).join('');
}
function visibleBatches(lane) {
  return state.batches.filter(batch => Number(batch.lanes?.[lane]?.applicants || 0) > 0);
}
function laneApplicants(lane) {
  return state.batches.reduce((sum, batch) => sum + Number(batch.lanes?.[lane]?.applicants || 0), 0);
}
function laneState(batch, stats) {
  if (!stats) return 'queued';
  if (isHistorical(batch)) return 'history';
  if (state.lane === 'rules' && batch.fast_completed_at) return 'completed';
  if (stats.pending > 0) return 'qualitative';
  return batch.matching_status === 'completed' || state.lane === 'rules' ? 'completed' : 'qualitative';
}
function renderMatches(batches) {
  const finished = batches.length > 0 && batches.every(batchComplete);
  $('#matches-card').hidden = !finished;
  $('#applicant-card').hidden = true;
  if (!finished) return;
  const counts = state.decisionCounts || {};
  $('#final-rules').textContent = number(counts.rules);
  $('#final-qualitative').textContent = number(counts.qualitative);
}

function chooseLane(lane) {
  if (!['rules','qualitative'].includes(lane)) return;
  state.lane = lane; state.offset = 0; state.search = ''; $('#applicant-search').value = ''; closeDetails(); renderMatches(state.batches);
}
function openBatch(id) {
  state.selectedBatch = id; state.offset = 0; state.search = ''; $('#applicant-search').value = '';
  $('#applicant-card').hidden = false; renderMatches(state.batches); loadApplicants();
  $('#applicants tbody').innerHTML = '<tr><td colspan="5" class="empty-state">Loading applicant decisions…</td></tr>';
  $('#history-note').hidden = true; $('#previous-page').disabled = true; $('#next-page').disabled = true;
  $('#applicant-card').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}
async function loadApplicants() {
  if (!state.selectedBatch) return;
  if (state.detailLoading) { state.detailRequested = true; return; }
  state.detailRequested = false;
  state.detailLoading = true;
  const sequence = ++state.detailSequence; state.lastDetailRefresh = Date.now();
  const batch = state.batches.find(batch => batch.batch_id === state.selectedBatch);
  const index = state.batches.indexOf(batch) + 1;
  $('#applicant-lane').textContent = state.lane === 'rules' ? 'NON-LLM / RULE-BASED DECISIONS' : 'DECIDER / LLM / QUALITATIVE DECISIONS';
  $('#applicant-title').textContent = `Batch ${String(index).padStart(2,'0')} applicants`;
  const params = new URLSearchParams({lane:state.lane,offset:state.offset,limit:25,q:state.search});
  $('#detail-message').textContent = 'Refreshing applicant decisions…';
  try {
    const response = await fetch(`/api/batches/${state.selectedBatch}/applicants?${params}`);
    if (!response.ok) throw Error('Applicant details could not be loaded. Select the batch to try again.');
    const data = await response.json(); if (sequence !== state.detailSequence) return;
    renderApplicants(data, batch); $('#detail-message').textContent = '';
  } catch (error) { if (sequence === state.detailSequence) $('#detail-message').textContent = error.message; }
  finally {
    state.detailLoading = false;
    if (state.detailRequested) loadApplicants();
  }
}
function splitDecisions(person) {
  const reasons = [];
  for (const decision of (person.decisions || [])) {
    if (!decision || decision.status !== 'ineligible') continue;
    for (const reason of (decision.reasons || [])) {
      const text = typeof reason === 'object' && reason !== null ? (reason.detail || reason.code) : String(reason || '');
      if (text && !reasons.includes(text)) reasons.push(text);
    }
  }
  return reasons;
}
/** The reasons why the applicant was rejected, in one short line. */
function rejectionReasons(person) {
  const reasons = splitDecisions(person);
  if (!reasons.length) return '';
  return reasons.length > 2 ? `${reasons.slice(0, 2).join('; ')} and ${reasons.length - 2} more` : reasons.join('; ');
}
function renderApplicants(data, batch) {
  const rows = data.applicants || [];
  $('#history-note').hidden = !rows.some(row => !row.complete_history);
  $('#applicant-summary').textContent = `${number(data.total)} applicants in this group. Expand a row to inspect all their loan decisions.`;
  $('#applicant-range').textContent = data.total ? `${data.offset+1}–${Math.min(data.offset+data.limit,data.total)} of ${number(data.total)}` : 'No applicants found';
  $('#previous-page').disabled = data.offset === 0; $('#next-page').disabled = data.offset+data.limit >= data.total;
  $('#applicants tbody').innerHTML = rows.length ? rows.map(person => {
    const pending = Number(person.pending_count || 0);
    const details = (person.decisions || []).map(decision => `<li><strong>${escapeHtml(decision.provider)}</strong><br><span class="muted">${escapeHtml(decision.product)}</span><br>${badge(decision.status)} <span class="muted">${decision.lane === 'qualitative' ? 'Qualitative check' : 'Rule check'}</span>${(decision.reasons || []).map(reason => `<p>${escapeHtml(typeof reason === 'object' ? (reason.code === 'PROVIDER_ERROR' ? 'Provider issue: ' : '') + (reason.detail || JSON.stringify(reason)) : reason)}</p>`).join('')}</li>`).join('');
    const why = rejectionReasons(person);
    const whyNote = why ? `<span class="cell-note">Not eligible: ${escapeHtml(why)}</span>` : '';
    return `<tr><td><span class="person-name">${escapeHtml(person.name)}</span><span class="person-email">${escapeHtml(person.email)}</span><span class="person-stats">${escapeHtml(person.employment_status)} · ${formatAmount(person.monthly_income)}/mo</span></td><td>${badge(person.status,person.status==='pending')}${pending ? `<span class="cell-note">${pending} checks still pending</span>` : ''}</td><td><span class="cell-note">${person.eligible_count} eligible · ${person.complete_history ? `${person.ineligible_count} not eligible` : 'rejections not recorded'}</span><span class="cell-note">${person.review_count} need review</span>${whyNote}</td><td>${badge(person.email_status,person.email_status==='pending')}<span class="cell-note">${person.email_status==='sent' ? `To ${escapeHtml(person.recipient)}` : person.email_status==='not_sent' ? 'Not selected for delivery or no matches' : person.email_status==='failed' ? escapeHtml(person.email_error || 'Delivery failed') : person.email_status==='pending' ? 'Waiting for the final notification pass' : 'No delivery record available'}</span></td><td><details class="loan-details"><summary>View loan decisions</summary><ul class="loan-list">${details}</ul></details></td></tr>`;
  }).join('') : '<tr><td colspan="5" class="empty-state">No applicants in this view. Try another batch or search.</td></tr>';
}
async function loadRecent() {
  try {
    const response = await fetch('/api/uploads?limit=25'); if (!response.ok) return;
    const { uploads = [] } = await response.json();
    $('#recent-uploads').innerHTML = '<option value="">Choose an upload…</option>' + uploads.map(upload => `<option value="${escapeHtml(upload.upload_id)}">${escapeHtml(upload.filename)} · ${number(upload.accepted_rows)} applicants · ${escapeHtml(upload.upload_id.slice(0,8))}</option>`).join('');
    if (state.uploadId) $('#recent-uploads').value = state.uploadId;
    return uploads;
  } catch { return []; }
}
async function loadCatalogue() {
  try {
    const response = await fetch('/api/products'); if (!response.ok) throw Error();
    const { products = [] } = await response.json(); $('#catalogue-summary').textContent = `${products.length} active products`;
    $('#catalogue tbody').innerHTML = products.map(product => `<tr><td>${escapeHtml(product.provider)}</td><td>${escapeHtml(product.product_name)}</td><td>${formatRate(product.interest_rate_min,product.interest_rate_max)}</td><td>${formatAmount(product.max_loan_amount)}</td><td>${formatTenure(product.min_tenure_months,product.max_tenure_months)}</td></tr>`).join('');
  } catch { $('#catalogue-summary').textContent = 'Catalogue unavailable'; }
}
document.addEventListener('DOMContentLoaded', async () => {
  $('#file').addEventListener('change', showFile); $('#upload-form').addEventListener('submit', submit);
  const dropzone = $('#dropzone');
  dropzone.addEventListener('click', event => { if(event.target !== $('#file')) $('#file').click(); });
  dropzone.addEventListener('keydown', event => { if(['Enter',' '].includes(event.key)) {event.preventDefault();$('#file').click();} });
  for (const name of ['dragenter','dragover','dragleave','drop']) dropzone.addEventListener(name, event => {event.preventDefault();dropzone.classList.toggle('over',['dragenter','dragover'].includes(name));});
  dropzone.addEventListener('drop', event => {if(event.dataTransfer?.files.length){$('#file').files=event.dataTransfer.files;showFile();}});
  for (const lane of ['rules','qualitative']) {
    const tab = $(`#lane-${lane}`);
    tab.addEventListener('click',()=>chooseLane(lane));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'rules' : event.key === 'End' ? 'qualitative' : lane === 'rules' ? 'qualitative' : 'rules';
      chooseLane(next); $(`#lane-${next}`).focus();
    });
  }
  $('#batch-grid').addEventListener('click',event=>{const card=event.target.closest('[data-batch]');if(card)openBatch(card.dataset.batch);});
  $('#close-details').addEventListener('click',closeDetails);
  $('#previous-page').addEventListener('click',()=>{state.offset=Math.max(0,state.offset-25);loadApplicants();});
  $('#next-page').addEventListener('click',()=>{state.offset+=25;loadApplicants();});
  let searchTimer;
  $('#applicant-search').addEventListener('input',event=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.search=event.target.value;state.offset=0;loadApplicants();},250);});
  $('#recent-uploads').addEventListener('change',event=>openUpload(event.target.value));
  loadCatalogue(); const uploads = await loadRecent();
  let saved; try {saved=localStorage.getItem('loan-upload-id');}catch{}
  const query = new URLSearchParams(location.search).get('upload');
  const id = query || (uploads || []).find(upload=>upload.upload_id===saved)?.upload_id;
  if(id)openUpload(id);
});
