/**
 * ============================================================================
 *  server-test.ts — standalone smoke test for the custom-provider wiring
 * ============================================================================
 *
 *  WHAT THIS PROVES
 *  ----------------
 *  Registers the same "native-local" OpenAI-compatible provider that
 *  server.js uses (legacy provider-config form), resolves the model, opens a
 *  Pi AgentSession, prompts "hi", and streams the assistant's reply to stdout.
 *  If you see a streamed reply with `[stop reason: stop]`, the whole chain
 *  works: provider → model → auth → agent loop → streaming.
 *
 *  RUN
 *  ---
 *    npx tsx server-test.ts
 *
 *  ENV  (read from .env next to this file, or the real environment)
 *  ----
 *    API_BASE        OpenAI-compatible endpoint  (default: https://api.openai.com/v1)
 *    MODEL_ID        Model id to register & call  (default: xiaomi/mimo-v2.5)
 *    OPENAI_API_KEY  API key for the endpoint     (required)
 *
 *  KEY LEARNINGS baked into this file (read the §-comments inline):
 *    §A  Provider registration is deferred when done via an extension factory.
 *    §B  Register directly on ModelRuntime to resolve the model up front.
 *    §C  setRuntimeApiKey wins over stored creds / env vars / $VAR config.
 *    §D  In-memory session/settings keep the test hermetic (no disk writes).
 * ============================================================================
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
//  Minimal .env loader (zero-dep). Real apps would use dotenv; this keeps the
//  test self-contained. Environment variables always win over .env values.
// ---------------------------------------------------------------------------
try {
	const envContent = await readFile(join(__dirname, ".env"), "utf8");
	for (const line of envContent.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue; // skip blanks/comments
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue; // skip malformed lines
		const key = trimmed.slice(0, eq).trim();
		const val = trimmed.slice(eq + 1).trim();
		if (!process.env[key]) process.env[key] = val;
	}
} catch {
	// No .env — fine if env vars are set directly.
}

const API_KEY = process.env.OPENAI_API_KEY;
const API_BASE = process.env.API_BASE || "https://api.openai.com/v1";
const MODEL_ID = process.env.MODEL_ID || "xiaomi/mimo-v2.5";

if (!API_KEY) {
	console.error("✗ OPENAI_API_KEY is required (set it in .env or the environment).");
	process.exit(1);
}

const PROVIDER_ID = "native-local";
const AGENT_DIR = join(__dirname, ".pi");

// ===========================================================================
//  §3  MODEL RUNTIME  +  CUSTOM PROVIDER
// ===========================================================================

const modelRuntime = await ModelRuntime.create({ agentDir: AGENT_DIR });

// §C — Auth priority #1: a runtime-injected key beats stored credentials,
//      env vars, and the `$OPENAI_API_KEY` placeholder in providerConfig below.
//      This is why the request below authenticates even when no creds are saved.
modelRuntime.setRuntimeApiKey(PROVIDER_ID, API_KEY);

/**
 * Provider config (legacy provider-config form — see pi's custom-provider.md,
 * "Register New Provider"). Declares exactly one model so getModel() can
 * resolve it. cost / contextWindow / maxTokens are placeholders; tune them if
 * you need usage accounting or context-aware compaction.
 *
 * Shared between TWO registration paths below (§A / §B).
 */
const providerConfig = {
	name: "Native Local",
	baseUrl: API_BASE,
	apiKey: "$OPENAI_API_KEY",
	api: "openai-completions" as const,
	models: [
		{
			id: MODEL_ID,
			name: MODEL_ID,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
		},
	],
};

// §B — Register DIRECTLY on the ModelRuntime. This is synchronous and makes
//      the model resolvable immediately, so getModel() works BEFORE any session
//      is opened. Without this, the model resolves to undefined here.
modelRuntime.registerProvider(PROVIDER_ID, providerConfig);

/**
 * Resource loader discovers extensions, tools, prompts, etc.
 *
 * §A — WHY we ALSO register the provider inside an extension factory:
 *      `pi.registerProvider()` called from an extension factory does NOT take
 *      effect immediately. It is *queued* on the extension runtime and only
 *      flushed into the ModelRuntime when the session starts, inside
 *      ExtensionRunner.bindCore() (which createAgentSession invokes). So the
 *      factory registration alone is too late for an up-front getModel() call.
 *
 *      We register in BOTH places:
 *        - on ModelRuntime (above): so we can pick the model now, and
 *        - via the factory (here):  so the provider is also known inside the
 *          running session once bindCore() flushes pending registrations.
 *
 *      Skills / prompts / agents-files are overridden to empty arrays so this
 *      test pulls in nothing project-specific — it is hermetic.
 */
const loader = new DefaultResourceLoader({
	cwd: __dirname,
	agentDir: AGENT_DIR,
	extensionFactories: [
		{
			name: "custom-provider",
			factory: (pi: any) => {
				pi.registerProvider(PROVIDER_ID, providerConfig);
			},
		},
	],
	skillsOverride: () => ({ skills: [], diagnostics: [] }),
	promptsOverride: () => ({ prompts: [], diagnostics: [] }),
	agentsFilesOverride: () => ({ agentsFiles: [], diagnostics: [] }),
});
await loader.reload();

// §D — In-memory settings keep the test stateless: no session files written,
//      no compaction, no retry. Each run is a clean, isolated turn.
const settingsManager = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: false },
});

// ===========================================================================
//  §4  RESOLVE MODEL  +  OPEN SESSION
// ===========================================================================

const model = modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
if (!model) {
	console.error(`✗ Model not found: ${PROVIDER_ID}/${MODEL_ID}`);
	console.error(`  Check that MODEL_ID ("${MODEL_ID}") matches a model your endpoint serves.`);
	process.exit(1);
}

console.log(`✓ Provider: ${model.provider} (${API_BASE})`);
console.log(`✓ Model:    ${model.provider}/${model.id}`);
console.log("");

const { session } = await createAgentSession({
	cwd: __dirname,
	model,
	modelRuntime,
	sessionManager: SessionManager.inMemory(),
	resourceLoader: loader,
	settingsManager,
});

// ===========================================================================
//  §5  PROMPT "hi"  +  STREAM THE REPLY
// ===========================================================================

session.subscribe((event) => {
	if (event.type === "message_update") {
		// Stream assistant text deltas to stdout as they arrive.
		const ae = event.assistantMessageEvent;
		if (ae?.type === "text_delta") {
			process.stdout.write(ae.delta);
		}
	} else if (event.type === "message_end") {
		const reason = event.message?.stopReason;
		if (event.message?.errorMessage) {
			console.error(`\n✗ Error: ${event.message.errorMessage}`);
		}
		console.log(`\n\n[stop reason: ${reason}]`);
	}
});

try {
	console.log("user: hi\n");
	console.log("assistant:");
	await session.prompt("hi");
} catch (err) {
	console.error(`\n✗ Prompt failed: ${(err as Error).message}`);
	process.exit(1);
} finally {
	session.dispose();
}
