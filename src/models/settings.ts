// Define a new interface for a single sync configuration
export interface SyncTarget {
	docId: string;
	folderPath: string;
	parentPageId: string | null; // Parent page ID (can be null for top-level pages)
}

// Interface for ClickUp Sync settings
export interface ClickUpSyncSettings {
	clickUpApiKey: string;
	clickUpWorkspaceId: string; // ClickUp Workspace ID for all operations
	syncTargets: SyncTarget[]; // Array of sync configurations
	syncOnSave: boolean; // Option to sync automatically when a file is saved
	pageMapping: Record<string, string>; // Mapping: Obsidian file path -> ClickUp Page ID
}

// Default settings values
export const DEFAULT_SETTINGS: ClickUpSyncSettings = {
	clickUpApiKey: '',
	clickUpWorkspaceId: '',
	syncTargets: [], // Initialize as empty array
	syncOnSave: false,
	pageMapping: {}, // Initialize empty mapping
} 