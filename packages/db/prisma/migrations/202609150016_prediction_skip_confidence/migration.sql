ALTER TABLE "prediction_versions"
  DROP CONSTRAINT "prediction_versions_confidence_check",
  ADD CONSTRAINT "prediction_versions_confidence_check"
    CHECK ("confidence" IN ('S', 'A', 'B', 'C', 'SKIP'));
