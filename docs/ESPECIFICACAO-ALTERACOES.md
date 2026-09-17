# Especificação V1 — registro de alterações

O arquivo `docs/especificacao-v1.docx` é mantido como recebido, intocado, para
auditoria de como o V1 foi originalmente definido. Alterações feitas pelo dono
depois da leitura inicial entram aqui, em ordem cronológica — este arquivo é a
fonte de verdade vigente quando divergir do `.docx`.

---

## 2026-09-17 — §16 "O que NÃO fazer na V1" — política Free-First

**Autorizado por:** Guilherme (dono do projeto), durante o M2.

**Antes:**

> Não comprar assets/serviços se alternativa gratuita adequada existir.

**Depois:**

> Priorizar soluções gratuitas, open-source e execução local. Recursos pagos
> somente poderão ser utilizados quando não houver alternativa gratuita
> adequada ou quando o uso pago apresentar benefício econômico ou operacional
> mensurável, sempre respeitando o orçamento, as permissões e os limites
> definidos pelo Governor.

**O que muda:** a regra anterior lia como uma proibição quase absoluta de
gasto ("só gratuito, salvo se não existir alternativa"). A nova redação
reconhece explicitamente um segundo caminho — gasto pago com benefício
econômico/operacional mensurável — mas mantém esse caminho condicionado ao
Governor, ao orçamento e às permissões da Constituição. Não é uma liberação de
autonomia financeira; é uma clarificação de que "Free-First" significa
prioridade, não proibição absoluta.

**O que NÃO muda (confirmado explicitamente pelo dono):**

- `AUTO_SPEND=false` continua valendo — nenhum gasto acontece sem aprovação
  explícita do fundador (`packages/governor/src/governor.ts`, `#evaluateSpend`).
- O alvo de custo de desenvolvimento continua R$0
  (`DEVELOPMENT_EXTERNAL_SERVICES_TARGET_BRL=0`).
- O bootstrap experimental continua limitado ao teto da Constituição
  (`EXPERIMENTAL_BOOTSTRAP_MAX_BRL`).
- Nenhum agente recebe acesso a cartão, conta bancária, carteira, chave
  privada ou credencial financeira — isso não estava em discussão e continua
  fora de cogitação.
- O Governor continua a autoridade final sobre limites e permissões; a
  Constituição continua não editável por um agente em execução
  (`ALLOW_SELF_MODIFICATION=false`).

**Impacto no código:** nenhum. Esta é uma clarificação de política para
milestones futuros (quando houver dado real de receita/custo, a partir do M4).
O M2 não usa nenhum serviço pago e não foi alterado por causa desta emenda —
`AI_MODE=mock` continua a única configuração de IA em uso, e a rota de gasto
(`SPEND` no Governor) já era, e continua sendo, negada por padrão sem
`AUTO_SPEND=true` ou aprovação explícita do fundador.

**Onde isso passa a valer:** a partir do M5 (ledger de custos) e de decisões
econômicas reais do Diretor com dado de mercado (M4+), esta é a redação que
resolve o trade-off "gratuito, mas pior" vs. "pago, mas economicamente
justificado" — sempre dentro do que o Governor autorizar.
