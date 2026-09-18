import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

/** packages/governor/{src,dist} → ../../../config/constitution.yaml */
export const DEFAULT_CONSTITUTION_PATH = fileURLToPath(new URL('../../../config/constitution.yaml', import.meta.url));

const positiveInt = z.number().int().min(1);

/**
 * Proibições da V1 são `z.literal(false)`: um YAML com `true` é rejeitado na
 * carga. Relaxar uma delas é decisão de código revisado, não de configuração.
 */
const constitutionSchema = z
  .object({
    versao: z.literal(1),
    free_first: z
      .object({
        prioridades: z.array(z.string().min(1)).min(1),
        DEVELOPMENT_EXTERNAL_SERVICES_TARGET_BRL: z.number().min(0),
        EXPERIMENTAL_BOOTSTRAP_MAX_BRL: z.number().min(0),
      })
      .strict(),
    permissoes: z
      .object({
        DIRECT_OUTREACH: z.literal(false),
        ALLOW_DEBT: z.literal(false),
        ALLOW_TRADING: z.literal(false),
        ALLOW_CRYPTO_MINING: z.literal(false),
        ALLOW_UNSCOPED_SECURITY_TESTING: z.literal(false),
        ALLOW_SECRET_ACCESS: z.literal(false),
        ALLOW_SELF_MODIFICATION: z.literal(false),
        AUTO_SPEND: z.literal(false),
      })
      .strict(),
    limites: z
      .object({
        MAX_TASK_RETRIES: z.number().int().min(0).max(10),
        MAX_PARALLEL_TASKS: z.number().int().min(1).max(16),
      })
      .strict(),
    /**
     * M6 (docs/M6-PLANO.md): defaults de engenharia da V1, conservadores e
     * configuráveis. Não são aprendizado comprovado da empresa: só um humano,
     * editando este arquivo, os altera. `AUTONOMY_ENABLED` é independente de
     * `AUTO_SPEND` e nunca amplia nenhuma permissão acima.
     */
    autonomia: z
      .object({
        AUTONOMY_ENABLED: z.boolean(),
        DISCOVERY_INTERVAL_SECONDS: positiveInt,
        RECONCILIATION_INTERVAL_SECONDS: positiveInt,
        PERFORMANCE_WINDOW_HOURS: positiveInt,
        RECOVERY_SWEEP_INTERVAL_SECONDS: positiveInt,
        LIFECYCLE_EVALUATION_INTERVAL_SECONDS: positiveInt,
        SOURCE_CIRCUIT_FAILURE_THRESHOLD: positiveInt,
        SOURCE_CIRCUIT_COOLDOWN_SECONDS: positiveInt,
        AGENT_CIRCUIT_MIN_SAMPLE: positiveInt,
        AGENT_CIRCUIT_CONSECUTIVE_FAILURES: positiveInt,
        AGENT_CIRCUIT_COOLDOWN_SECONDS: positiveInt,
        LIFECYCLE_MIN_SAMPLE: positiveInt,
        LIFECYCLE_PROMOTE_CONSECUTIVE_WINDOWS: positiveInt,
        LIFECYCLE_SLEEP_CONSECUTIVE_BAD_WINDOWS: positiveInt,
        LIFECYCLE_TRANSITION_COOLDOWN_HOURS: positiveInt,
        SLEEP_MIN_DURATION_HOURS: positiveInt,
        EMERGENCY_QUIESCENCE_TIMEOUT_SECONDS: positiveInt,
        RESERVATION_STALE_AFTER_SECONDS: positiveInt,
      })
      .strict(),
  })
  .strict();

export type Constitution = z.infer<typeof constitutionSchema>;

export class ConstitutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConstitutionError';
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function parseConstitution(raw: unknown): Readonly<Constitution> {
  const parsed = constitutionSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
      .join('\n');
    throw new ConstitutionError(`Constituição inválida:\n${problems}`);
  }
  return deepFreeze(parsed.data);
}

export function loadConstitution(path: string = DEFAULT_CONSTITUTION_PATH): Readonly<Constitution> {
  const absolutePath = resolve(path);
  let text: string;
  try {
    text = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new ConstitutionError(`Não foi possível ler a constituição em ${absolutePath}`, { cause: error });
  }
  return parseConstitution(parse(text));
}
