import builtins from "builtin-modules";
import esbuild from "esbuild";
import fs from "fs";
import process from "process";

const banner =
`/*
THIS IS A GENERATED/BUNDLED FILE BY ESBUILD
if you want to view the source, please visit the github repository of this plugin
*/
`;

const prod = (process.argv[2] === "production");

// Create dist directory if it doesn't exist
const ensureDistDir = () => {
	if (!fs.existsSync("dist")) {
		fs.mkdirSync("dist", { recursive: true });
	}
};

// Copy files to dist directory
const copyToDistDir = () => {
	// Copy manifest.json to dist
	fs.copyFileSync("manifest.json", "dist/manifest.json");
	
	// Copy styles.css to dist if it exists
	if (fs.existsSync("styles.css")) {
		fs.copyFileSync("styles.css", "dist/styles.css");
	}
	
	// Copy LICENSE to dist if it exists
	if (fs.existsSync("LICENSE")) {
		fs.copyFileSync("LICENSE", "dist/LICENSE");
	}
	
	console.log("Files copied to dist directory");
};

const buildConfig = {
	banner: {
		js: banner,
	},
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: prod ? "dist/main.js" : "main.js", // Output to dist in production
	minify: prod,
};

// Main build process
const build = async () => {
	if (prod) {
		// For production, ensure dist directory exists before building
		ensureDistDir();
		
		// Build the project
		await esbuild.build(buildConfig);
		
		// Copy necessary files to dist directory
		copyToDistDir();
		
		console.log("Production build completed.");
	} else {
		// For development, just watch for changes
		const context = await esbuild.context(buildConfig);
		await context.watch();
		console.log("Watching for changes...");
	}
};

// Run the build
build().catch(err => {
	console.error("Build failed:", err);
	process.exit(1);
});
