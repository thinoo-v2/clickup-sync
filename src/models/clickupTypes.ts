// Structure for ClickUp Page (simplified) from API response
export interface ClickUpPage {
	id: string;
	name: string;
	parent_id?: string | null; // ID of the parent page, can be undefined, null or string
	// Add other relevant fields if needed
}

// Structure for ClickUp Page with hierarchy information
export interface ClickUpPageNode extends ClickUpPage {
	parent_id: string | null;
	children: ClickUpPageNode[];
	pages?: ClickUpPageNode[]; // Add pages field which may be used instead of children
}