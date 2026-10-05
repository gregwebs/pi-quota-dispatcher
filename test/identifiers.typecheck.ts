/**
 * Compile-time regression fixture for the configuration identifier newtypes.
 *
 * Included by `tsconfig.json` (the `test` directory) but never run: `npm test`
 * globs `test/*.test.ts`, and this file ends in `.typecheck.ts`. Its only
 * purpose is that `npm run typecheck` fails if any of the guarantees below
 * stops holding — each `@ts-expect-error` is checked to actually suppress an
 * error, so removing a brand or widening a signature breaks the build.
 *
 * It is deliberately not a runtime test. Every `declare const` here is an
 * existential proof, not a value.
 */
import type { AgentRoute, Candidate, ConfigBase, DispatcherConfig } from "../src/config.ts";
import { agentKey, mergeConfig, skillKey } from "../src/config.ts";
import type { AgentName, ModelId, SkillName } from "../src/identifiers.ts";
import { parseAgentName, parseModelId, parseSkillName } from "../src/identifiers.ts";
import type { AgentWrite, NamedAgentFile, ScopedNameFile } from "../src/index.ts";
import { upsertModel } from "../src/index.ts";
import type { ModelCheckResult, ModelMiss } from "../src/models.ts";
import type { AgentFileSelection } from "../src/skill-binding.ts";
import { validatedKeys } from "../src/validated-keys.ts";

declare const raw: string;
declare const agent: AgentName;
declare const model: ModelId;
declare const skill: SkillName;
declare const cfg: DispatcherConfig;
declare const base: ConfigBase;
declare const checked: ModelCheckResult;

// A raw string cannot populate a branded domain field, and cannot key a branded
// table. These are the two failures the brands exist to make impossible.
// @ts-expect-error `model` on a candidate is a ModelId, not any string
const rawCandidate: Candidate = { model: raw, rail: "claude" };
// @ts-expect-error an agent table key is an AgentName, not any string
const rawAgents: Record<AgentName, AgentRoute> = { planner: cfg.agents[agent] };
// @ts-expect-error a model table key is a ModelId, not any string
const rawModels: Record<ModelId, Candidate> = { "claude-bridge/opus": rawCandidate };

// The three identifier roles are not interchangeable.
// @ts-expect-error a ModelId is not an AgentName
const modelAsAgent: AgentName = model;
// @ts-expect-error a SkillName is not a ModelId
const skillAsModel: ModelId = skill;
// @ts-expect-error an AgentName is not a SkillName
const agentAsSkill: SkillName = agent;

// A branded key does not satisfy a different role's formatter.
// @ts-expect-error agentKey takes an AgentName, not a ModelId
agentKey(model);
// @ts-expect-error skillKey takes a SkillName, not an AgentName
skillKey(agent);

// Wrong-role table indexing is a compile error.
// @ts-expect-error the agents table is not keyed by ModelId
cfg.agents[model];
// @ts-expect-error the models table is not keyed by SkillName
cfg.models[skill];
// @ts-expect-error the skills table is not keyed by AgentName
cfg.skills[agent];

// Recovering keys from an already-validated table keeps each table's brand.
const agentNames: AgentName[] = validatedKeys(cfg.agents);
const modelIds: ModelId[] = validatedKeys(cfg.models);
const skillNames: SkillName[] = validatedKeys(cfg.skills);

// A checked identifier is still an ordinary string: branding does not change
// the representation, only what the compiler will accept for it.
const agentText: string = agent;
const modelText: string = model;
const skillText: string = skill;

// Raw input is the checked producers' input, not a branded value.
const parsedAgent = parseAgentName(raw);
const parsedModel = parseModelId(raw);
const parsedSkill = parseSkillName(raw);
const parsedAgentValue: AgentName | undefined = "value" in parsedAgent ? parsedAgent.value : undefined;
const parsedModelValue: ModelId | undefined = "value" in parsedModel ? parsedModel.value : undefined;
const parsedSkillValue: SkillName | undefined = "value" in parsedSkill ? parsedSkill.value : undefined;

// The programmatic base keeps accepting raw table keys as parser input.
const rawKeyedBase: ConfigBase = {
  ...base,
  agents: { planner: cfg.agents[agent] },
  models: { "claude-bridge/opus": {} },
  skills: { "code-review": raw },
};
mergeConfig(rawKeyedBase, []);

// Raw discovery and diagnostic evidence stay raw: a raw string still
// populates every such field, so branding one would fail this build.
const evidenceMiss: ModelMiss = { key: raw, model: raw };
const evidenceFile: NamedAgentFile = { kind: "agent", name: raw, file: raw, model: raw, thinking: raw };
const evidenceScoped: ScopedNameFile = { kind: "scoped", declared: raw, file: raw };
const evidenceSelection: Extract<AgentFileSelection, { kind: "file" }> = { kind: "file", model: raw, thinking: raw };
const evidenceWrite: AgentWrite = { file: raw, model, base: raw, dry: false };
// Index the value type directly: a computed-key object literal does not prove
// the value type, but an assignment to `held[AgentName]` does.
const evidenceHeldValue: ModelCheckResult["held"][AgentName] = raw;
const evidenceDroppedValue: ModelCheckResult["droppedAlternates"][AgentName] = [
  { key: raw, model: raw },
];

// The written-model seam takes a ModelId, so a raw string no longer compiles.
// @ts-expect-error the written model is a ModelId, not any string
upsertModel(raw, raw);
const upserted: string | null = upsertModel(raw, model);

// A value that is only ever read is used here so the file has no unused locals.
void [
  rawCandidate,
  rawAgents,
  rawModels,
  modelAsAgent,
  skillAsModel,
  agentAsSkill,
  agentNames,
  modelIds,
  skillNames,
  agentText,
  modelText,
  skillText,
  parsedAgentValue,
  parsedModelValue,
  parsedSkillValue,
  evidenceMiss,
  evidenceFile,
  evidenceScoped,
  evidenceSelection,
  evidenceWrite,
  evidenceHeldValue,
  evidenceDroppedValue,
  upserted,
  checked,
];
