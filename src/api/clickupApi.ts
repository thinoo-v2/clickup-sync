import { Notice, requestUrl, TFile } from 'obsidian';
import { ClickUpPage, ClickUpPageNode } from '../models/clickupTypes';
import { ClickUpSyncSettings, SyncTarget } from '../models/settings';

export interface ClickUpAPI {
  getClickUpDocPages(docId: string): Promise<ClickUpPage[] | null>;
  getClickUpDocPagesTree(docId: string): Promise<ClickUpPageNode[] | null>;
  getClickUpPageContent(pageId: string, docId?: string): Promise<string | null>;
  syncFileToClickupPage(file: TFile, syncTarget: SyncTarget, existingPages?: ClickUpPage[] | null): Promise<boolean>;
}

/**
 * Gets all pages for a specific ClickUp Doc.
 * Handles potential errors.
 * @param docId The ID of the ClickUp Doc to fetch pages from.
 * @param settings Plugin settings containing API keys
 */
export async function getClickUpDocPages(docId: string, settings: ClickUpSyncSettings): Promise<ClickUpPage[] | null> {
    const { clickUpApiKey, clickUpWorkspaceId } = settings;
    // Using the passed docId instead of a global setting
    if (!clickUpApiKey || !clickUpWorkspaceId) {
        console.warn('ClickUp API Key or Workspace ID not configured.');
        // Can't proceed without these global settings
        new Notice('ClickUp API Key or Workspace ID not configured.');
        return null;
    }
    if (!docId) {
        console.warn('No Doc ID provided to getClickUpDocPages.');
        // Cannot fetch pages without a specific Doc ID
        return null;
    }

    // Use the provided docId in the API URL
    const apiUrl = `https://api.clickup.com/api/v3/workspaces/${clickUpWorkspaceId}/docs/${docId}/pages`;

    try {
        const response = await requestUrl({
            method: 'GET',
            url: apiUrl,
            headers: { 'Authorization': clickUpApiKey },
            throw: false,
        });

        if (response.status === 200) {
            // Assuming the response body has a 'pages' array based on typical API design
            // Adjust this based on the actual API response structure if needed
            return response.json.pages || response.json || [];
        } else {
            console.error(`Error fetching ClickUp pages for Doc ${docId}: ${response.status}`, response.json);
            new Notice(`Error fetching pages for Doc ${docId}: ${response.json?.err || 'Unknown error'} (Status: ${response.status})`);
            return null;
        }
    } catch (error) {
        console.error(`Failed to fetch ClickUp pages for Doc ${docId}:`, error);
        new Notice(`Failed to fetch pages for Doc ${docId}. Check console.`);
        return null;
    }
}

/**
 * Gets all pages for a specific ClickUp Doc and organizes them in a tree structure.
 * Handles potential errors.
 * @param docId The ID of the ClickUp Doc to fetch pages from.
 * @param settings Plugin settings containing API keys
 */
export async function getClickUpDocPagesTree(docId: string, settings: ClickUpSyncSettings): Promise<ClickUpPageNode[] | null> {
    // First, get all pages using existing method
    const pages = await getClickUpDocPages(docId, settings);
    
    if (!pages) {
        return null; // Error already handled in getClickUpDocPages
    }
    
    // Convert flat pages list to tree structure
    const pageMap = new Map<string, ClickUpPageNode>();
    const rootNodes: ClickUpPageNode[] = [];
    
    // First pass: create all nodes with empty children arrays
    pages.forEach(page => {
        const pageNode: ClickUpPageNode = {
            ...page,
            parent_id: page.parent_id || null,
            children: [],
        };
        pageMap.set(page.id, pageNode);
    });
    
    // Second pass: build the tree by adding children to their parents
    
    pageMap.forEach(page => {
        if (page.parent_id && pageMap.has(page.parent_id)) {
            // If it has a parent, add it to the parent's children
            const parentNode = pageMap.get(page.parent_id);
            if (parentNode) {
                parentNode.children.push(page);
                // Also add to pages array for compatibility
                if (parentNode.pages) {
                    parentNode.pages.push(page);
                } else {
                    parentNode.pages = [page];
                }
            }
        } else {
            // No parent or parent not found, it's a root node
            rootNodes.push(page);
        }
    });
    
    console.log(`Built page tree: ${rootNodes.length} root pages, ${pages.length} total pages`);
    return rootNodes;
}

/**
 * Syncs a single Obsidian file to a specific ClickUp Doc Page based on the sync target.
 * Creates a new page or updates an existing one based on mapping or name matching.
 *
 * @param file The Obsidian file to sync.
 * @param syncTarget The specific sync configuration (docId, folderPath) for this file.
 * @param settings Plugin settings containing API keys and mappings
 * @param existingPages Optional: Pre-fetched list of pages for the target ClickUp Doc.
 * @returns {Promise<boolean>} True if sync was successful, false otherwise.
 */
export async function syncFileToClickupPage(
    file: TFile, 
    syncTarget: SyncTarget,
    settings: ClickUpSyncSettings,
    existingPages?: ClickUpPage[] | null
): Promise<boolean> {
    const { clickUpApiKey, clickUpWorkspaceId, pageMapping } = settings;
    const { docId } = syncTarget; // Get the target Doc ID from the syncTarget object

    // Removed check for clickUpTargetDocId as we now use docId from syncTarget
    if (!clickUpApiKey || !clickUpWorkspaceId) {
        new Notice('ClickUp API Key or Workspace ID not configured.');
        return false; // Indicate failure
    }
    if (!docId) {
        console.error(`[Sync Error] Sync target for folder "${syncTarget.folderPath}" is missing a Doc ID.`);
        new Notice(`Sync target configuration error for folder ${syncTarget.folderPath}.`);
        return false;
    }

    let fileContent: string;
    try {
        fileContent = await file.vault.cachedRead(file);
        // Limit logging length for large files
        console.log(`[Sync Debug] File: ${file.path}, Content Length: ${fileContent.length}, Target Doc: ${docId}`);
    } catch (readError) {
        console.error(`[Sync Error] Failed to read file: ${file.path}`, readError);
        new Notice(`Failed to read file ${file.basename}. Cannot sync.`);
        return false;
    }

    const fileName = file.basename;
    // Generate a unique key for the mapping based on file path AND target doc ID
    // This prevents conflicts if the same file name exists under different sync targets
    const mappingKey = `${docId}:::${file.path}`;
    let targetPageId: string | null = pageMapping[mappingKey] || null; // Check mapping first

    // If not in mapping, try to find by name in existing pages for THIS doc
    if (!targetPageId && existingPages) {
        const foundPage = existingPages.find(page => page.name === fileName);
        if (foundPage) {
            targetPageId = foundPage.id;
            settings.pageMapping[mappingKey] = targetPageId; // Use the unique key
            console.log(`Mapped existing page '${fileName}' (ID: ${targetPageId}) in Doc ${docId} to file ${file.path}`);
            // Save settings immediately when a mapping is added by discovery
            // This requires saving settings from outside, so we return a mapping update flag
        }
    }

    let response;
    let success = false;
    let requestBody: Record<string, any>;
    let responseJson: any = null; // Variable to hold parsed JSON safely

    try {
        // --- First attempt to update if we have a targetPageId ---
        if (targetPageId) {
            console.log(`Updating page '${fileName}' (ID: ${targetPageId}) in Doc ${docId} for file: ${file.path}`);
            // Use the docId from syncTarget in the URL
            const updateUrl = `https://api.clickup.com/api/v3/workspaces/${clickUpWorkspaceId}/docs/${docId}/pages/${targetPageId}`;
            requestBody = {
                name: fileName,
                content: fileContent,
                content_format: 'text/md',
            };

            response = await requestUrl({
                method: 'PUT',
                url: updateUrl,
                headers: { 'Authorization': clickUpApiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                throw: false, // Important: Prevent throwing on non-2xx codes
            });

            // --- Safely attempt to parse JSON ---
            try {
                // Only parse if response text exists and content type suggests JSON
                if (response.text && response.headers['content-type']?.includes('application/json')) {
                    responseJson = JSON.parse(response.text); // Parse from text to avoid Obsidian's auto-parsing issues
                }
            } catch (parseError) {
                console.error(`[Sync Error] Failed to parse PUT response body for page ${targetPageId} in Doc ${docId}:`, parseError);
                console.log(`[Sync Debug] PUT Raw Response Text:`, response.text);
            }

            // --- Check status code for success ---
            // Accept 200 OK or 204 No Content as success for PUT
            if (response.status === 200 || response.status === 204) {
                console.log(`Successfully updated page '${fileName}' in ClickUp Doc ${docId} (Status: ${response.status}).`);
                success = true;
                return success; // Early return on successful update
            } else {
                // Log the error but don't return yet - we'll try creating a new page
                console.warn(`Error updating page '${fileName}' (ID: ${targetPageId}) in Doc ${docId}: Status ${response.status}. Will attempt to create a new page instead.`, responseJson || response.text);
                new Notice(`Could not update page ${fileName}. Attempting to create new page instead...`);
                
                // Remove the invalid mapping if we couldn't update the page (it might have been deleted in ClickUp)
                delete settings.pageMapping[mappingKey];
                targetPageId = null; // Reset targetPageId to force creation of a new page
            }
        }

        // --- Create New Page (either initially or after failed update) ---
        console.log(`Creating new page for file: ${file.path} in Doc ${docId}`);
        // Use the docId from syncTarget in the URL
        const createUrl = `https://api.clickup.com/api/v3/workspaces/${clickUpWorkspaceId}/docs/${docId}/pages`;
        requestBody = {
            name: fileName,
            content: fileContent,
            content_format: 'text/md',
        };
        
        // Add parent_page_id to request body if it exists
        if (syncTarget.parentPageId) {
            requestBody.parent_page_id = syncTarget.parentPageId;
        }

        response = await requestUrl({
            method: 'POST',
            url: createUrl,
            headers: { 'Authorization': clickUpApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            throw: false,
        });

        // --- Safely attempt to parse JSON ---
        try {
            if (response.text && response.headers['content-type']?.includes('application/json')) {
                responseJson = JSON.parse(response.text);
            }
        } catch (parseError) {
            console.error(`[Sync Error] Failed to parse POST response body for page creation in Doc ${docId}:`, parseError);
            console.log(`[Sync Debug] POST Raw Response Text:`, response.text);
            if(!(response.status >= 200 && response.status < 300)) {
                new Notice(`Sync error: Invalid response from ClickUp (POST). Status: ${response.status}`);
            }
        }

        // --- Check status code AND response body for success ---
        // Expecting 200 or 201 Created with an ID in the body
        if ((response.status === 200 || response.status === 201) && responseJson?.id) {
            const newPageId = responseJson.id;
            settings.pageMapping[mappingKey] = newPageId; // Use the unique key
            console.log(`Successfully created page '${fileName}' (ID: ${newPageId}) in ClickUp Doc ${docId}.`);
            success = true;
        } else {
            console.error(`Error creating page for '${fileName}' in Doc ${docId}: Status ${response.status}`, responseJson || response.text);
            new Notice(`Error creating page ${fileName} in Doc ${docId}: ${responseJson?.err || 'Create error'} (Status: ${response.status})`);
        }

    } catch (error) {
        // Catch errors from requestUrl itself (network issues, etc.)
        console.error(`[Sync Error] Failed to sync file ${file.path} to ClickUp page in Doc ${docId}:`, error);
        new Notice(`Failed to sync ${file.basename}. Check console.`);
        success = false; // Ensure success is false on general error
    }
    
    return success; // Return success status
}

/**
 * Gets the markdown content for a ClickUp page
 * @param pageId ClickUp page ID
 * @param docId Optional: The ClickUp Doc ID containing this page (if known)
 * @param settings Plugin settings containing API keys and mappings
 * @returns The markdown content or null if failed
 */
export async function getClickUpPageContent(
    pageId: string, 
    docId: string | undefined, 
    settings: ClickUpSyncSettings
): Promise<string | null> {
    const { clickUpApiKey, clickUpWorkspaceId } = settings;
    
    try {
        // If docId wasn't provided, we need to determine which Doc this page belongs to
        if (!docId) {
            // Look through the mapping keys to find the Doc ID 
            // Mapping keys are in format: ${docId}:::${filePath}
            for (const key of Object.keys(settings.pageMapping)) {
                if (settings.pageMapping[key] === pageId) {
                    const parts = key.split(':::');
                    if (parts.length === 2) {
                        docId = parts[0];
                        break;
                    }
                }
            }
            
            // If we can't find the docId in mappings, try to get it from sync targets
            if (!docId) {
                for (const target of settings.syncTargets) {
                    // We'll need to fetch pages for each doc to check
                    const pages = await getClickUpDocPages(target.docId, settings);
                    if (pages && pages.some(page => page.id === pageId)) {
                        docId = target.docId;
                        break;
                    }
                }
            }
            
            // If we still don't have a docId, we can't proceed
            if (!docId) {
                console.error(`Cannot determine Doc ID for page ${pageId}`);
                return null;
            }
        }
        
        // First try getting the page content by downloading the page content directly
        // ClickUp API endpoint for page content
        const url = `https://api.clickup.com/api/v3/workspaces/${clickUpWorkspaceId}/docs/${docId}/pages/${pageId}`;
        
        const response = await requestUrl({
            method: 'GET',
            url: url,
            headers: { 'Authorization': clickUpApiKey },
            throw: false,
        });
        
        if (response.status === 200) {
            // ClickUp typically returns page content either in 'content' or 'body'
            // Since we want markdown format, we specify that in our request
            let content = '';
            
            // Check if we need to make a second request to get markdown content
            // Some ClickUp API versions return only metadata in the first request
            if (response.json.id && !response.json.content) {
                // Try a second request with format specified for content
                const contentUrl = `https://api.clickup.com/api/v3/workspaces/${clickUpWorkspaceId}/docs/${docId}/pages/${pageId}/content?format=markdown`;
                
                const contentResponse = await requestUrl({
                    method: 'GET',
                    url: contentUrl,
                    headers: { 'Authorization': clickUpApiKey },
                    throw: false,
                });
                
                if (contentResponse.status === 200) {
                    // The content might be in different places depending on the API version
                    content = contentResponse.json.content || 
                        contentResponse.json.markdown || 
                        contentResponse.json.text || 
                        contentResponse.text || '';
                } else {
                    console.error(`Error fetching markdown content for page ${pageId}: ${contentResponse.status}`, contentResponse.json);
                }
            } else {
                // Try to get content from first response
                content = response.json.content || 
                    response.json.markdown || 
                    response.json.body || 
                    response.json.text || '';
            }
            
            // Add a title and metadata to the content
            const pageTitle = response.json.name || 'ClickUp Page';
            const formattedContent = `# ${pageTitle}\n\n` + 
                `*ClickUp Page ID: ${pageId}*\n\n` +
                content;
            
            return formattedContent;
        } else {
            console.error(`Error fetching content for page ${pageId}: ${response.status}`, response.json);
            return null;
        }
    } catch (error) {
        console.error(`Failed to fetch content for page ${pageId}:`, error);
        return null;
    }
} 