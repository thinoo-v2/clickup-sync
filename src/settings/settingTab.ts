import { App, Notice, PluginSettingTab, Setting, TextComponent } from 'obsidian';
import ClickUpSyncPlugin from '../main';
import { ParentPageIdModal } from '../views/modals';

export class ClickUpSyncSettingTab extends PluginSettingTab {
	plugin: ClickUpSyncPlugin;
	syncTargetsContainer: HTMLElement;

	constructor(app: App, plugin: ClickUpSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Simple implementation for now
		containerEl.createEl('h2', { text: 'ClickUp Doc Sync Settings' });

		// API Key
		new Setting(containerEl)
			.setName('ClickUp API Key')
			.setDesc('Your personal ClickUp API Key')
			.addText(text => text
				.setPlaceholder('pk_xxxxxxx')
				.setValue(this.plugin.settings.clickUpApiKey)
				.onChange(async (value) => {
					this.plugin.settings.clickUpApiKey = value.trim();
					await this.plugin.saveSettings();
				}));

		// Workspace ID
		new Setting(containerEl)
			.setName('ClickUp Workspace ID')
			.setDesc('The ID of the ClickUp Workspace used for all operations')
			.addText(text => text
				.setPlaceholder('1234567')
				.setValue(this.plugin.settings.clickUpWorkspaceId)
				.onChange(async (value) => {
					this.plugin.settings.clickUpWorkspaceId = value.trim();
					await this.plugin.saveSettings();
				}));

		// Sync on Save Option
		new Setting(containerEl)
			.setName('Sync on Save')
			.setDesc('Automatically sync files to ClickUp when they are saved in Obsidian')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnSave)
				.onChange(async (value) => {
					this.plugin.settings.syncOnSave = value;
					await this.plugin.saveSettings();
				}));

		// Setup Wizard Button
		// const wizardContainer = containerEl.createDiv();
		// wizardContainer.addClass('setup-wizard-container');
		// wizardContainer.style.textAlign = 'center';
		// wizardContainer.style.marginTop = '20px';
		// wizardContainer.style.marginBottom = '20px';
		
		// const wizardButton = wizardContainer.createEl('button', { 
		// 	text: 'Launch Setup Wizard',
		// 	cls: 'mod-cta'
		// });
		// wizardButton.addEventListener('click', () => {
		// 	this.plugin.launchSetupWizard();
		// });
		
		// Add help text below the button
		// const helpText = wizardContainer.createEl('div', { 
		// 	text: 'Quickly set up a new sync target using the wizard'
		// });
		// helpText.style.fontSize = '12px';
		// helpText.style.color = 'var(--text-muted)';
		// helpText.style.marginTop = '5px';

		// Add section for sync targets
		containerEl.createEl('h3', { text: 'Sync Targets' });
		containerEl.createEl('p', { text: 'Configure folders to sync with specific ClickUp Doc IDs and parent pages' });

		// Container for sync targets
		this.syncTargetsContainer = containerEl.createDiv('sync-targets-container');
		
		// Render existing sync targets
		this.renderSyncTargets();

		// Add button to add a new sync target
		new Setting(containerEl)
			.setName('Add Sync Target')
			.setDesc('Add a new folder to sync with ClickUp')
			.addButton(button => button
				.setButtonText('Add')
				.setCta()
				.onClick(() => {
					this.plugin.settings.syncTargets.push({
						docId: '',
						folderPath: '',
						parentPageId: null
					});
					this.plugin.saveSettings().then(() => {
						this.renderSyncTargets();
					});
				}));
	}

	renderSyncTargets(): void {
		this.syncTargetsContainer.empty();
		
		if (this.plugin.settings.syncTargets.length === 0) {
			this.syncTargetsContainer.createEl('p', { 
				text: 'No sync targets configured. Add one below.' 
			});
			return;
		}

		// Create a container for each sync target
		this.plugin.settings.syncTargets.forEach((target, index) => {
			const targetContainer = this.syncTargetsContainer.createDiv('sync-target-item');
			
			targetContainer.createEl('h4', { 
				text: `Target ${index + 1}: ${target.folderPath || '(Vault Root)'} → ${target.docId || '(Not Set)'}` 
			});

			// Doc ID
			new Setting(targetContainer)
				.setName('ClickUp Doc ID')
				.setDesc('The ID of the ClickUp Doc to sync with')
				.addText(text => text
					.setPlaceholder('Enter Doc ID')
					.setValue(target.docId)
					.onChange(async (value) => {
						this.plugin.settings.syncTargets[index].docId = value.trim();
						await this.plugin.saveSettings();
					}));

			// Folder Path
			new Setting(targetContainer)
				.setName('Obsidian Folder Path')
				.setDesc('Path to the folder in Obsidian vault to sync (leave empty for root)')
				.addText(text => text
					.setPlaceholder('folder/subfolder')
					.setValue(target.folderPath)
					.onChange(async (value) => {
						this.plugin.settings.syncTargets[index].folderPath = value.trim();
						await this.plugin.saveSettings();
					}));

			// Parent Page ID with Picker Button
			const parentPageSetting = new Setting(targetContainer)
				.setName('Parent Page ID')
				.setDesc('ID of the parent page in ClickUp (leave empty for top level)');

			let parentPageInput: TextComponent;
			
			parentPageSetting.addText(text => {
				parentPageInput = text;
				return text
					.setPlaceholder('Optional parent page ID')
					.setValue(target.parentPageId || '')
					.onChange(async (value) => {
						this.plugin.settings.syncTargets[index].parentPageId = value.trim() || null;
						await this.plugin.saveSettings();
					});
			});

			// Pull Pages Button
			parentPageSetting.addButton(button => button
				.setButtonText('Pull Pages')
				.onClick(async () => {
					try {
						const docId = this.plugin.settings.syncTargets[index].docId;
						const folderPath = this.plugin.settings.syncTargets[index].folderPath;
						const parentPageId = this.plugin.settings.syncTargets[index].parentPageId;

						if (!docId) {
							new Notice('Please set a ClickUp Doc ID first');
							return;
						}

						// Get the page tree from ClickUp
						const pageTree = await this.plugin.api.getClickUpDocPagesTree(docId);
						if (!pageTree) {
							new Notice('Failed to fetch pages from ClickUp');
							return;
						}

						// Start the sync process
						await this.plugin.syncLogic.syncDownFromClickUp(
							docId,
							folderPath || '',
							parentPageId
						);

					} catch (error) {
						console.error('Error during pull operation:', error);
						new Notice('Failed to pull pages from ClickUp. Check console for details.');
					}
				}));
			
	
			// Delete Button
			new Setting(targetContainer)
				.addButton(button => button
					.setButtonText('Delete')
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.syncTargets.splice(index, 1);
						await this.plugin.saveSettings();
						this.renderSyncTargets();
					}));

			// Add separator
			if (index < this.plugin.settings.syncTargets.length - 1) {
				targetContainer.createEl('hr');
			}
		});
	}

	/**
	 * Prompts the user for a parent page ID
	 */
	async promptForParentPageId(): Promise<string | null> {
		return new Promise((resolve) => {
			const modal = new ParentPageIdModal(this.app, (result) => {
				resolve(result);
			});
			modal.open();
		});
	}
} 