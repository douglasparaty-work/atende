# Atende

Plataforma de atendimento multicanal. É uma reconstrução funcional, independente, inspirada no Umbler Talk: foram observadas as telas e a API pública dele (35 telas, ~300 endpoints), sem copiar código.

## Rodar

```bash
git clone https://github.com/douglasparaty-work/atende.git && cd atende
npm install && npm start
```

Abra http://localhost:3900. No primeiro acesso você cria a conta do proprietário. Requer Node ≥ 22.13: usa `node:sqlite` e nenhum build.

IA (agentes, melhorar texto, sugestões e resumo) aceita vários provedores **com fallback automático**:
- Defina as chaves que tiver antes do `npm start`.
- Se um provedor falhar (limite grátis, fora do ar, modelo inválido), o próximo responde.
- O provedor que falhou fica de lado por 60 s (limite) ou 15 s (outros erros).

| Provedor | Chave | Modelo padrão (troque com `<NOME>_MODEL`) |
|---|---|---|
| Claude (pago) | `ANTHROPIC_API_KEY` | `claude-opus-5-5` |
| Google Gemini (grátis com limites) | `GEMINI_API_KEY` | `gemini-flash-latest,gemini-flash-lite-latest,gemini-3.5-flash` |
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

Sem nenhuma chave, o resto funciona e as conversas com agente de IA vão para a fila. Se todos os provedores falharem, a conversa também vai para um atendente. Os modelos padrão podem sair de linha: se der erro de modelo, defina `<NOME>_MODEL` (ex.: `GEMINI_MODEL`); aceita uma lista separada por vírgula, tentada em ordem.

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
- **Canais**: WhatsApp por QR code, widget de site (`/widget.html?c=ID`, embutível via iframe) e API (`POST /api/v1/inbound` para plugar outro provedor).
- **Relatórios**: totais, primeira resposta, tempo até finalizar, por atendente/canal/setor/etiqueta/dia/hora/DDD.
- **Configurações**: perfil, preferências (Enter, notificações, som), tokens de API, empresa, atendentes com papéis (Membro/Operador/Admin/Proprietário), setores, canais, etiquetas, conversas, inatividade, listar todas as conversas, atividades.
- **Webhooks**: filtro de eventos, assinatura HMAC (`X-Signature`), log de entregas.
- **API pública** com token pessoal. Rotas documentadas em Configurações › API.

## Conectar o seu WhatsApp

1. Entre no app › **Configurações › Canais de atendimento › Novo canal**, tipo **WhatsApp (QR code)**.
2. Na linha do canal, clique em **Conectar WhatsApp › Gerar QR code**.
3. No celular: **WhatsApp › Aparelhos conectados › Conectar um aparelho** e leia o código.
4. Pronto: as mensagens que chegarem nesse número aparecem em **Conversas** (aba Esperando) e você responde pelo Atende. Chatbots, agentes de IA, etiquetas e campanhas funcionam no canal.

A sessão fica salva em `wa-auth/` (fora do git; quem tiver essa pasta controla o seu WhatsApp, então proteja-a). O servidor religa sozinho ao reiniciar, mas precisa ficar ligado para receber mensagens.

⚠️ **Risco:** é a conexão não oficial do WhatsApp Web (biblioteca Baileys), contra os termos do WhatsApp. O número pode ser banido, principalmente com envio em massa ou mensagens para quem não falou com você. Teste com um chip secundário. As campanhas neste canal já fazem uma pausa aleatória entre envios (`WA_CAMPAIGN_DELAY_MS`, padrão 6000), o que reduz o risco mas não o elimina. Para volume ou uso crítico, use a API oficial da Meta (WhatsApp Cloud API) ligada ao canal de API.

Limites atuais: só texto (imagem, áudio e arquivo chegam como [imagem], [áudio]...), grupos são ignorados e mensagens digitadas direto no celular não aparecem no Atende.

## Fora do escopo

Estas partes exigem contratos externos:
- transporte oficial WhatsApp/Instagram (Meta/Gupshup); o WhatsApp por QR code acima é o caminho não oficial;
- aprovação de templates;
- WhatsApp Flows;
- créditos e cobrança;
- login Umbler Conta/2FA;
- push;
- pipelines.

O canal API é o ponto de integração para um provedor.

## Licença

MIT — veja [LICENSE](LICENSE). Projeto independente, sem vínculo com a Umbler.
