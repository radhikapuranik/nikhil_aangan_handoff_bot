-- After-call audit of what the voice platform's AI actually said.
-- NULL = not audited (no transcript); empty array = audited and clean.
alter table calls add column if not exists audit_issues text[];
