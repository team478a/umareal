ALTER TABLE "system_settings"
DROP CONSTRAINT "system_settings_content_access_policy_shape";

ALTER TABLE "system_settings"
ADD CONSTRAINT "system_settings_content_access_policy_shape" CHECK ((
  jsonb_typeof("contentAccessPolicy") = 'object'
  AND jsonb_typeof("contentAccessPolicy"->'monthly') = 'object'
  AND jsonb_typeof("contentAccessPolicy"->'dayPass') = 'object'
  AND jsonb_typeof("contentAccessPolicy"->'manual') = 'object'
  AND jsonb_typeof("contentAccessPolicy"->'monthly'->'paddock') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'monthly'->'win5') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'monthly'->'racePaper') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'dayPass'->'paddock') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'dayPass'->'win5') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'dayPass'->'racePaper') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'manual'->'paddock') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'manual'->'win5') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'manual'->'racePaper') = 'boolean'
) IS TRUE);
