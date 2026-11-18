export interface ProvinceSettings {
  enabled: boolean;
  opacity: number;
  lineColor: string;
  lineWidth: number;
}

export const provinceLineWidths = [0.5, 1, 1.5, 2, 3, 4, 6] as const;
export const defaultProvinceSettings: Readonly<ProvinceSettings> = {
  enabled: true,
  opacity: 1,
  lineColor: '#000000',
  lineWidth: 1,
};

export function normalizeProvinceSettings(value: unknown): ProvinceSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : defaultProvinceSettings.enabled,
    opacity: typeof input.opacity === 'number' && Number.isFinite(input.opacity)
      ? Math.max(0, Math.min(1, input.opacity)) : defaultProvinceSettings.opacity,
    lineColor: typeof input.lineColor === 'string' && /^#[0-9a-f]{6}$/i.test(input.lineColor)
      ? input.lineColor.toUpperCase() : defaultProvinceSettings.lineColor,
    lineWidth: typeof input.lineWidth === 'number' && provinceLineWidths.some((width) => width === input.lineWidth)
      ? input.lineWidth : defaultProvinceSettings.lineWidth,
  };
}

export function provinceSettingsKey(url: string, layer: string) {
  return `digitalearth:province-settings:v1:${url}:${layer}`;
}

export function loadProvinceSettings(key: string, storage?: Pick<Storage, 'getItem'>): ProvinceSettings {
  try {
    return normalizeProvinceSettings(JSON.parse((storage ?? window.localStorage).getItem(key) ?? 'null'));
  } catch {
    return { ...defaultProvinceSettings };
  }
}

export function saveProvinceSettings(key: string, settings: ProvinceSettings, storage?: Pick<Storage, 'setItem'>) {
  try {
    (storage ?? window.localStorage).setItem(key, JSON.stringify(normalizeProvinceSettings(settings)));
    return true;
  } catch {
    return false;
  }
}
