import type { ReactElement } from 'react';
import { createElement as el } from 'react';
import { AgentsSettingsPage } from './SettingsAgents.js';
import { ModelsSettingsPage } from './SettingsModels.js';
import { SafetySettingsPage } from './SettingsSafety.js';
import { RecentChanges } from '../components/RecentChanges.js';

/** The settings pages rendered by the component tests. */
export function agentsPage(): ReactElement { return el(AgentsSettingsPage); }
export function modelsPage(): ReactElement { return el(ModelsSettingsPage); }
export function safetyPage(): ReactElement { return el(SafetySettingsPage); }
export function recentChanges(): ReactElement { return el(RecentChanges); }
