-- The evaluation draft stores legs together with review reasons and the calculated summary.
-- This only widens the JSON shape accepted by the new additive draft table.
ALTER TABLE "win5_evaluation_drafts"
  DROP CONSTRAINT "win5_evaluation_drafts_legsSnapshot_check",
  ADD CONSTRAINT "win5_evaluation_drafts_legsSnapshot_check" CHECK (jsonb_typeof("legsSnapshot") = 'object');
