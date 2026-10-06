ALTER TABLE ai_race_guide_generations
  DROP CONSTRAINT "ai_race_guide_generations_modelProvider_check";

ALTER TABLE ai_race_guide_generations
  ADD CONSTRAINT "ai_race_guide_generations_modelProvider_check"
  CHECK ("modelProvider" IN ('test', 'template', 'disabled'));

CREATE OR REPLACE FUNCTION enforce_ai_race_guide_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_attempt INTEGER;
BEGIN
  PERFORM 1 FROM ai_race_guides WHERE id = NEW."guideId" FOR UPDATE;
  SELECT COALESCE(MAX("attemptNo"), 0) INTO previous_attempt FROM ai_race_guide_generations WHERE "guideId" = NEW."guideId";
  IF NEW."attemptNo" <> previous_attempt + 1 THEN RAISE EXCEPTION 'AI guide generation sequence is invalid'; END IF;
  IF NEW."modelProvider" NOT IN ('test', 'template') OR NEW."validationStatus" = 'VALID' AND NEW."generatedOutput" IS NULL THEN
    RAISE EXCEPTION 'AI guide generation provider or output is invalid';
  END IF;
  RETURN NEW;
END $$;
