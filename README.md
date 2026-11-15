# Atende

Plataforma de atendimento multicanal. É uma reconstrução funcional do Umbler Talk, mapeado em 2026-11-12. A evidência da engenharia reversa está em observação das telas e da API pública do Umbler Talk (35 telas, ~300 endpoints).

## Rodar

```bash
cd atende && npm install && npm start
```

Abra http://localhost:3900. No primeiro acesso você cria a conta do proprietário. Requer Node ≥ 22.13: usa `node:sqlite` e nenhum build.

IA (agentes, melhorar texto, sugestões e resumo) aceita vários provedores **com fallback automático**:
- Defina as chaves que tiver antes do `npm start`.
- Se um provedor falhar (limite grátis, fora do ar, modelo inválido), o próximo responde.
- O provedor que falhou fica de lado por 60 s (limite) ou 15 s (outros erros).

| Provedor | Chave | Modelo padrão (troque com `<NOME>_MODEL`) |
|---|---|---|
| Claude (pago) | `ANTHROPIC_API_KEY` | `claude-opus-5-5` |
| Google Gemini (grátis com limites) | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| Groq (grátis com limites) | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| OpenRouter (modelos `:free`) | `OPENROUTER_API_KEY` | `meta-llama/llama-3.3-70b-instruct:free` |
| NVIDIA Build (créditos grátis) | `NVIDIA_API_KEY` | `meta/llama-3.3-70b-instruct` |
| Qualquer API compatível com OpenAI | `AI_BASE_URL` + `AI_API_KEY` + `AI_MODEL` | — |
| Ollama (só se listado em `AI_PROVIDERS`) | — (`OLLAMA_BASE_URL` para outro servidor) | `qwen2.5:7b` |

- **Ordem:** por padrão, a da tabela, só com os provedores que têm chave. Para escolher, use por exemplo `AI_PROVIDERS=gemini,groq,openrouter`.
- **Outro endereço:** cada provedor aceita `<NOME>_BASE_URL`, por exemplo `OLLAMA_BASE_URL=http://IP:11434/v1`.

Exemplo:

```bash
GEMINI_API_KEY=... GROQ_API_KEY=... OPENROUTER_API_KEY=... npm start
```

Sem nenhuma chave, o resto funciona e as conversas com agente de IA vão para a fila. Se todos os provedores falharem, a conversa também vai para um atendente. Os modelos padrão podem sair de linha: se der erro de modelo, defina `<NOME>_MODEL` (ex.: `GEMINI_MODEL`).

Teste ponta a ponta: `npm test`.

## O que tem

- **Conversas**: abas Entrada / Esperando / Finalizados, busca e filtro por setor, tempo real (SSE).
  - Ações: atender, transferir (setor/atendente + nota), privar, finalizar (com mensagem ou chatbot de avaliação), reabrir.
  - Mensagens: notas internas, assinatura, respostas rápidas com `/`, apagar mensagem, etiquetas.
  - IA: melhorar texto, 3 sugestões, resumo.
- **Contatos**: CRUD, busca, importação CSV, etiquetas, notas fixáveis, campos personalizados, bloqueio, histórico.
- **Chatbots**: editor de passos.
  - Passos: mensagem, menu de opções, pergunta com validação regex, etiqueta, condição, horário de atendimento, webhook, aguardar, ir para, transferir setor/atendente, passar para IA, finalizar.
  - Disparo: no canal (nova conversa), manualmente na conversa ou via campanha/agendamento.
- **Agentes de IA + bases de conhecimento** (perguntas e respostas), com transferência para humano.
- **Campanhas** por etiqueta, imediatas ou agendadas, com progresso. **Mensagens agendadas** (mensagem, nota, chatbot).
- **Canais**: Widget de site (`/widget.html?c=ID`, embutível via iframe) e API (`POST /api/v1/inbound` para plugar WhatsApp/Instagram via provedor).
- **Relatórios**: totais, primeira resposta, tempo até finalizar, por atendente/canal/setor/etiqueta/dia/hora/DDD.
- **Configurações**: perfil, preferências (Enter, notificações, som), tokens de API, empresa, atendentes com papéis (Membro/Operador/Admin/Proprietário), setores, canais, etiquetas, conversas, inatividade, listar todas as conversas, atividades.
- **Webhooks**: filtro de eventos, assinatura HMAC (`X-Signature`), log de entregas.
- **API pública** com token pessoal. Rotas documentadas em Configurações › API.

## Fora do escopo

Estas partes exigem contratos externos:
- transporte oficial WhatsApp/Instagram (Meta/Gupshup);
- aprovação de templates;
- WhatsApp Flows;
- créditos e cobrança;
- login Umbler Conta/2FA;
- push;
- pipelines.

O canal API é o ponto de integração para um provedor.

## Licença

MIT — veja [LICENSE](LICENSE). Projeto independente, sem vínculo com a Umbler.
