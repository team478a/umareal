ALTER TABLE "win5_result_drafts" DROP CONSTRAINT "win5_result_drafts_legsSnapshot_check";
ALTER TABLE "win5_result_drafts" ADD CONSTRAINT "win5_result_drafts_legsSnapshot_check" CHECK (jsonb_typeof("legsSnapshot") = 'object');
