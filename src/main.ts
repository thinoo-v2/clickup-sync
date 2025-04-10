import { Debouncer, Notice, Plugin, TFile } from 'obsidian';
import { ClickUpAPI, getClickUpDocPagesTree } from './api/clickupApi';
import { ClickUpPageNode } from './models/clickupTypes';
import { ClickUpSyncSettings, DEFAULT_SETTINGS, SyncTarget } from './models/settings';
import { ClickUpSyncSettingTab } from './settings/settingTab';

// Helper functions
import {
  displayPageTreeInModal,
  handleAutoSync,
  processClickUpPageForDownload,
  syncClickUpToVault,
  syncVaultToClickupDoc
} from './core/syncLogic';
import { DocIdInputModal, ParentPageIdModal, SyncParamsModal } from './views/modals';

export default class ClickUpSyncPlugin extends Plugin {
	settings: ClickUpSyncSettings;
	apiClient: ClickUpAPI;
	saveSettingsDebounced: Debouncer<[], Promise<void>>;
	settingsTab: ClickUpSyncSettingTab;
	statusBarItem: HTMLElement;

	async onload() {
		await this.loadSettings();

		// Load mapping initially
		this.settings.pageMapping = (await this.loadData())?.pageMapping || {};

		// --- Settings Tab ---
		this.addSettingTab(new ClickUpSyncSettingTab(this.app, this));

		// --- Ribbon Icon (Optional) ---
		this.addRibbonIcon('upload-cloud', 'Sync to ClickUp Doc Pages', (evt: MouseEvent) => {
			syncVaultToClickupDoc.call(this);
		});

		// --- Command Palette Command ---
		this.addCommand({
			id: 'sync-obsidian-to-clickup-doc-pages',
			name: 'Sync specific folder to ClickUp Doc Pages',
			callback: () => {
				syncVaultToClickupDoc.call(this);
			}
		});

		// Add command to fetch and display page tree structure
		this.addCommand({
			id: 'fetch-clickup-page-tree',
			name: 'Fetch ClickUp Doc Page Tree',
			callback: async () => {
				// Simple prompt to get the Doc ID
				const result = await this.promptForDocId();
				if (!result) return;

				const { docId, folderPath } = result;
				
				new Notice(`Fetching page tree for Doc ID: ${docId}...`);
				const pageTree = await getClickUpDocPagesTree(docId, this.settings);
				
				if (pageTree) {
					// Create and open a new leaf with the page tree visualization
					displayPageTreeInModal.call(this, pageTree, docId);
					
					// If folder path was provided, create or update sync target
					if (folderPath !== undefined) {
						// Check if this target already exists
						const existingTargetIndex = this.settings.syncTargets.findIndex(
							(target: SyncTarget) => target.docId === docId && target.folderPath === folderPath
						);
						
						if (existingTargetIndex >= 0) {
							new Notice(`Sync target already exists for Doc ID: ${docId} and folder: ${folderPath || '(Vault Root)'}`);
						} else {
							// Add new sync target
							this.settings.syncTargets.push({
								docId: docId,
								folderPath: folderPath,
								parentPageId: null
							});
							await this.saveSettings();
							new Notice(`Added new sync target: ${folderPath || '(Vault Root)'} → ${docId}`);
						}
					}
				}
			}
		});

		// Add command to sync child pages from a specific parent page ID
		this.addCommand({
			id: 'sync-clickup-child-pages',
			name: 'Sync child pages from ClickUp to Obsidian',
			callback: async () => {
				// Prompt for Doc ID, folder path, and parent page ID
				const result = await this.promptForSyncParams();
				if (!result) return;

				const { docId, folderPath, parentPageId } = result;
				
				if (!docId || !parentPageId) {
					new Notice('Doc ID and Parent Page ID are required');
					return;
				}
				
				// Create temporary sync target
				const syncTarget = {
					docId: docId,
					folderPath: folderPath,
					parentPageId: null
				};
				
				// Execute the sync with the parent page ID filter
				new Notice(`Starting sync of child pages from parent ID: ${parentPageId}...`);
				await syncClickUpToVault.call(this, syncTarget, parentPageId);
			}
		});

		// Add a command to launch the setup wizard
		this.addCommand({
			id: 'launch-clickup-sync-setup-wizard',
			name: 'Launch ClickUp Sync Setup Wizard',
			callback: async () => {
				await this.launchSetupWizard();
			}
		});

		// --- Automatic Sync on Save (if enabled) ---
		this.registerEvent(
			this.app.vault.on('modify', async (file) => { // Make callback async
				if (this.settings.syncOnSave && file instanceof TFile) {
					// Use the new handler function for auto-sync
					await handleAutoSync.call(this, file);
				}
			})
		);

		console.log('ClickUp Doc Sync Plugin loaded.');
	}

	onunload() {
		console.log('ClickUp Doc Sync Plugin unloaded.');
	}

	async loadSettings() {
		// Load settings, ensuring pageMapping is merged correctly
		const loadedData = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
		// Ensure pageMapping exists, even if loading old data without it
		this.settings.pageMapping = this.settings.pageMapping || {};
	}

	async saveSettings() {
		// Save settings including the pageMapping
		await this.saveData(this.settings);
	}

	// Custom methods that are not directly imported from other files
	async promptForDocId(): Promise<{docId: string, folderPath: string} | null> {
		return new Promise((resolve) => {
			const modal = new DocIdInputModal(this.app, (result) => {
				resolve(result);
			});
			modal.open();
		});
	}

	async promptForSyncParams(): Promise<{docId: string, folderPath: string, parentPageId: string} | null> {
		return new Promise((resolve) => {
			const modal = new SyncParamsModal(this.app, (result) => {
				resolve(result);
			});
			modal.open();
		});
	}

	async launchSetupWizard() {
		// We'll use a series of modals to guide the user through setup

		// Step 1: Configure API Key and Default Workspace ID if not already set
		if (!this.settings.clickUpApiKey || !this.settings.defaultWorkspaceId) {
			new Notice("Please set up your ClickUp API Key and Default Workspace ID in the settings first.");
			this.settingsTab.display(); // Open settings tab
			return;
		}

		// Step 2: Prompt for Doc ID
		const docResult = await this.promptForDocId();
		if (!docResult) return;

		const { docId, folderPath } = docResult;
		new Notice(`Fetching page tree for Doc ID: ${docId}...`);
		
		// Step 3: Fetch page tree to show user
		const pageTree = await getClickUpDocPagesTree(docId, this.settings);
		if (!pageTree) {
			new Notice("Failed to fetch page tree. Please check your Doc ID and API Key.");
			return;
		}

		// Step 4: Display page tree and let user select a parent page if desired
		displayPageTreeInModal.call(this, pageTree, docId);

		// Step 5: Prompt for parent page ID (optional)
		const parentPageId = await new Promise<string | null>((resolve) => {
			const modal = new ParentPageIdModal(this.app, (result) => {
				resolve(result);
			});
			modal.open();
		});

		// Step 6: Create the sync target
		if (docId) {
			// Check if this target already exists
			const existingTargetIndex = this.settings.syncTargets.findIndex(
				(target: SyncTarget) => target.docId === docId && target.folderPath === folderPath
			);
			
			if (existingTargetIndex >= 0) {
				new Notice(`Sync target already exists for Doc ID: ${docId} and folder: ${folderPath || '(Vault Root)'}`);
			} else {
				// Add new sync target
				this.settings.syncTargets.push({
					docId: docId,
					folderPath: folderPath,
					parentPageId: parentPageId
				});
				await this.saveSettings();
				new Notice(`Added new sync target: ${folderPath || '(Vault Root)'} → ${docId}${parentPageId ? ` (Parent: ${parentPageId})` : ''}`);
				
				// Ask user if they want to sync now
				const shouldSync = confirm("Sync target added successfully. Would you like to sync now?");
				if (shouldSync) {
					await syncVaultToClickupDoc.call(this);
				}
			}
		}
	}

	processClickUpPageForDownload(page: ClickUpPageNode, docId: string, basePath: string, currentPath: string, processedFileNames: Set<string>) {
		return processClickUpPageForDownload.call(this, page, docId, basePath, currentPath, processedFileNames);
	}
}

