DROP TRIGGER "billing_support_requests_no_delete" ON "billing_support_requests";
DROP FUNCTION reject_billing_support_request_delete();

CREATE OR REPLACE FUNCTION protect_billing_support_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'billing support requests cannot be deleted'; END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."userId" IS DISTINCT FROM OLD."userId" OR
     NEW."paymentTransactionId" IS DISTINCT FROM OLD."paymentTransactionId" OR
     NEW."category" IS DISTINCT FROM OLD."category" OR NEW."message" IS DISTINCT FROM OLD."message" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'billing support request content is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "billing_support_requests_guard" BEFORE UPDATE OR DELETE ON "billing_support_requests" FOR EACH ROW EXECUTE FUNCTION protect_billing_support_request();
