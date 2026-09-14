ALTER TABLE "audio_assets" DROP CONSTRAINT "audio_assets_content_type_check";
ALTER TABLE "audio_assets" ADD CONSTRAINT "audio_assets_content_type_check" CHECK ("contentType" IN ('audio/webm', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/aac'));
