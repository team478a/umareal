export function lineNotificationState(input: { available: boolean; enabled: boolean; configured: boolean }) {
  if (!input.available) return { paused: false, configurationMissing: false, affectsPublicMessage: false };
  return {
    paused: !input.enabled,
    configurationMissing: input.enabled && !input.configured,
    affectsPublicMessage: !input.enabled || !input.configured
  };
}
