ALTER TABLE "users" DROP CONSTRAINT "users_registration_method_check";

ALTER TABLE "users" ADD CONSTRAINT "users_registration_method_check" CHECK (
  "registrationMethod" IN ('EMAIL','LINE') AND
  (
    "registrationMethod" <> 'EMAIL' OR
    ("email" IS NOT NULL AND ("passwordHash" IS NOT NULL OR "authSubject" IS NOT NULL))
  ) AND
  ("email" IS NULL OR "passwordHash" IS NOT NULL OR "authSubject" IS NOT NULL)
);
