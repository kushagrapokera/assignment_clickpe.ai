-- Exclusive applicant groups: a person needing any qualitative check belongs
-- to that group, while their complete set of loan decisions remains visible.
CREATE VIEW ui_applicant_lanes AS
SELECT batch_id, user_id,
       CASE WHEN bool_or(lane = 'qualitative') THEN 'qualitative' ELSE 'rules' END AS lane
FROM ui_decisions
GROUP BY batch_id, user_id;
