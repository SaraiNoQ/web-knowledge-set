-- Papers are extracted either from the whole PDF or from rendered page images,
-- depending on what the configured endpoint accepts. The choice has to survive
-- a retry: a task that already committed to images must not go back to sending
-- a PDF the endpoint has rejected.
ALTER TABLE cloud_paper_extractions ADD COLUMN content_mode TEXT
  CHECK (content_mode IS NULL OR content_mode IN ('pdf', 'image'));
