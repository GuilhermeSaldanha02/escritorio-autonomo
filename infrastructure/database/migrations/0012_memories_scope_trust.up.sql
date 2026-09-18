-- 0012 — escopo de task e nível de confiança em memories (M5, critérios 7 e 10).
--
-- scope_task_id completa os quatro escopos do plano (empresa/agente/task/
-- capability): NULL = não restrito por task.
--
-- trust_level (critério 7): conteúdo UNTRUSTED_EXTERNAL (M4) que virou memória
-- continua marcado como tal e nunca é devolvido como conhecimento da empresa
-- por padrão. Sem DEFAULT: toda inserção declara a confiança explicitamente,
-- mesmo padrão de ledger_scope. Linhas que já existissem seriam backfilladas
-- como UNTRUSTED_EXTERNAL (o lado conservador), nunca INTERNAL.
ALTER TABLE memories
  ADD COLUMN scope_task_id uuid REFERENCES tasks (id),
  ADD COLUMN trust_level text NOT NULL DEFAULT 'UNTRUSTED_EXTERNAL'
    CHECK (trust_level IN ('INTERNAL', 'UNTRUSTED_EXTERNAL'));
ALTER TABLE memories ALTER COLUMN trust_level DROP DEFAULT;

CREATE INDEX memories_scope_task_idx ON memories (scope_task_id) WHERE scope_task_id IS NOT NULL;

-- Reentrega de uma proposta nunca grava a mesma memória duas vezes: mesma
-- experiência, mesmo conteúdo, mesmo escopo = a mesma memória.
CREATE UNIQUE INDEX memories_dedup_idx ON memories (
  experience_id,
  md5(content),
  COALESCE(scope_agent_id, ''),
  COALESCE(scope_capability, ''),
  COALESCE(scope_task_id::text, '')
);

-- Remove o índice ivfflat criado na 0011. A consulta de recuperação (escopo +
-- confiança + desempate por id) nunca o usa — o planner escolhe o índice de
-- escopo e ordena por distância, resultado exato — então ele só custava
-- escrita e dava a falsa impressão de busca indexada. Além disso, um ivfflat
-- criado sobre tabela vazia avisa "low recall" (medido: 53 de 300 linhas com
-- o probes padrão). Busca aproximada (HNSW/ivfflat) é decisão para quando
-- houver volume e um EmbeddingProvider real, fora do M5.
DROP INDEX memories_embedding_idx;
