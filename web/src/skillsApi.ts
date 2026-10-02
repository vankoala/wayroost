import type { MarketPreview, MarketSearch, SkillList, SkillScan } from '../../shared/skills';
import { request } from './api';

// Settings → Skills (see server/src/skills.ts).

export const skillsApi = {
  list: () => request<SkillList>('GET', '/api/skills'),
  refresh: () => request<SkillList>('POST', '/api/skills/refresh', {}),
  content: (place: string, name: string) =>
    request<{ text: string; truncated: boolean }>('GET', `/api/skills/content?${new URLSearchParams({ place, name })}`),
  share: (place: string, name: string, confirmCaution = false) =>
    request<{ shared: boolean; scan: SkillScan }>('POST', '/api/skills/share', { place, name, confirmCaution }),
  takeShared: (place: string, name: string) => request<SkillList>('POST', '/api/skills/take-shared', { place, name }),
  setExcluded: (name: string, place: string, excluded: boolean) =>
    request<SkillList>('PUT', '/api/skills/excluded', { name, place, excluded }),
  remove: (name: string) => request<SkillList>('POST', '/api/skills/remove', { name }),
  search: (q: string) => request<MarketSearch>('GET', `/api/skills/market?${new URLSearchParams({ q })}`),
  preview: (identifier: string) =>
    request<MarketPreview>('GET', `/api/skills/market/preview?${new URLSearchParams({ identifier })}`),
  install: (identifier: string, confirmCaution = false) =>
    request<{ started: boolean; scan: SkillScan }>('POST', '/api/skills/market/install', { identifier, confirmCaution }),
};
