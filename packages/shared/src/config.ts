import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Raiz do monorepo: packages/shared/{src,dist} → ../../.. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const postgresUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
    message: 'deve começar com postgres:// ou postgresql://',
  });

const redisUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'), {
    message: 'deve começar com redis:// ou rediss://',
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  AI_MODE: z.enum(['mock', 'local', 'api']).default('mock'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'use apenas letras minúsculas, números e hífen')
    .default('escritorio'),
  CONSTITUTION_PATH: z.string().min(1).optional(),
  /**
   * Segredo do fundador para a rota administrativa do Emergency Stop. Vem SÓ do ambiente do
   * processo da API: nenhum agente, prompt, Tool Gateway ou sandbox o recebe. Ausente, a rota
   * nem existe (404) e a CLI é o único caminho.
   */
  FOUNDER_ADMIN_SECRET: z.string().min(16, 'use pelo menos 16 caracteres').optional(),
  /** Prazo para API/Worker encerrarem graciosamente. O orquestrador de processos precisa esperar mais que isso. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
});

export type AppConfig = z.infer<typeof envSchema>;
export type AiMode = AppConfig['AI_MODE'];

/**
 * Carrega o `.env` da raiz, se existir. Variáveis já definidas no processo
 * têm precedência — o arquivo nunca sobrescreve o ambiente.
 */
export function loadEnvFile(path = `${REPO_ROOT}.env`): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

/** Valida o ambiente e falha cedo, com a lista completa de problemas. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Configuração inválida:\n${problems}`);
  }

  // O AI Gateway (M3) é quem implementará local/api. Até lá, aceitar outro
  // modo seria fingir uma integração que não existe.
  if (parsed.data.AI_MODE !== 'mock') {
    throw new ConfigError(
      `AI_MODE=${parsed.data.AI_MODE} ainda não está implementado (previsto no M3). Use AI_MODE=mock.`,
    );
  }

  return parsed.data;
}
