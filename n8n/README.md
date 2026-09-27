# N8N Knowledge Gap Workflow

Workflow automatique qui comble les lacunes de connaissances détectées par PharmaLLM.

## Flux

```
Webhook POST → Ollama (génère 3 queries) → SearXNG (recherche web)
  → Fetch pages → Ollama (extraction) → Filtre pertinence → Stockage KB → Log
```

## Prérequis

| Service     | URL par défaut             | Rôle                        |
|-------------|----------------------------|-----------------------------|
| PharmaLLM   | `http://localhost:3000`    | API knowledge (ingest-text) |
| Ollama      | `http://localhost:11434`   | LLM (gemma2:9b)             |
| SearXNG     | `http://localhost:8888`    | Recherche web               |
| N8N         | `http://localhost:5678`    | Orchestration               |

## Import dans N8N

1. Ouvrir N8N → **Workflows** → **Import from File**
2. Sélectionner `knowledge_gap_workflow.json`
3. Activer le workflow (toggle en haut à droite)
4. Récupérer l'URL du webhook dans le noeud **Knowledge Gap Webhook** :
   - En mode test : `http://localhost:5678/webhook-test/knowledge-gap`
   - En mode production : `http://localhost:5678/webhook/knowledge-gap`

## Configuration de PharmaLLM

Définir la variable d'environnement pour connecter le gap-detector :

```bash
export N8N_WEBHOOK_URL="http://localhost:5678/webhook/knowledge-gap"
```

Ou ajouter dans un fichier `.env` :

```
N8N_WEBHOOK_URL=http://localhost:5678/webhook/knowledge-gap
```

## Test manuel avec curl

```bash
curl -X POST http://localhost:5678/webhook-test/knowledge-gap \
  -H "Content-Type: application/json" \
  -d '{
    "original_query": "What cybersecurity incidents affected Pfizer in 2024?",
    "search_topic": "Pfizer cybersecurity incidents 2024",
    "timestamp": "2026-03-09T12:00:00.000Z",
    "gemma_response": "I do not have specific information about Pfizer cybersecurity incidents in 2024.",
    "reason": "Model response indicates lack of specific knowledge"
  }'
```

Utiliser `webhook-test` (pas `webhook`) pour tester sans activer le workflow en production.

## Noeuds du workflow

| #  | Noeud                          | Type         | Description                                    |
|----|--------------------------------|--------------|------------------------------------------------|
| 1  | Knowledge Gap Webhook          | Webhook      | Reçoit le POST du gap-detector                 |
| 2  | Generate Search Queries        | HTTP Request | Ollama génère 3 queries de recherche           |
| 3  | Parse Search Queries           | Code         | Parse la réponse JSON en 3 items               |
| 4  | Search SearXNG                 | HTTP Request | Recherche web pour chaque query                |
| 5  | Deduplicate Results            | Code         | Déduplique par URL, max 9 résultats            |
| 6  | Fetch Page Content             | HTTP Request | Récupère le contenu de chaque page             |
| 7  | Truncate & Clean Content       | Code         | Strip HTML, tronque à 8000 chars               |
| 8  | Extract Knowledge (Ollama)     | HTTP Request | Ollama extrait les infos pertinentes           |
| 9  | Filter Relevant Only           | Code         | Filtre les réponses NOT_RELEVANT               |
| 10 | Store in Knowledge Base        | HTTP Request | POST vers PharmaLLM /api/knowledge/ingest-text |
| 11 | Summary & Log                  | Code         | Agrège les stats et log le résultat            |
| 12 | Check Gap Resolution           | HTTP Request | POST vers PharmaLLM pour vérifier la résolution |
| 13 | Resolution Result Log          | Code         | Log le verdict, ou l'échec de la décision       |

## Résolution de lacune (trois états)

The resolution check returns a three-way verdict from the local scorer
(`resolved` / `review` / `unresolved`) plus the probability behind it. A
`review` gap is parked for a human and does **not** increment `retry_count`:
the middle of the scorer's distribution is the part least worth acting on.
Thresholds live in `config/decide.yaml`.

## Gestion des erreurs

- **Ollama (query generation)** : fallback sur `search_topic` directement
- **SearXNG** : log l'erreur et stop proprement
- **Fetch page** : skip les pages en erreur, continue avec les autres
- **Ollama (extraction)** : les erreurs passent au filtre qui les élimine
- **Store** : les erreurs n'empêchent pas le résumé final
- **Check Gap Resolution** : ses deux sorties (succès et erreur) arrivent au log.
  Une panne du scorer, un 500, un 404 ou un timeout est journalisé
  `gap_decision_failed` avec son détail, jamais comme un verdict : un appel qui
  échoue n'a rien décidé, et la ligne de base de données reste intacte.

## Timeouts

| Opération         | Timeout |
|-------------------|---------|
| Fetch page        | 30s     |
| Ollama (queries)  | 60s     |
| Ollama (extract)  | 120s    |
| Store in KB       | 30s     |

## Troubleshooting

**Le webhook ne reçoit rien :**
- Vérifier que `N8N_WEBHOOK_URL` est défini dans l'env de PharmaLLM
- Vérifier que le workflow est activé dans N8N
- Tester avec curl (voir ci-dessus)

**SearXNG ne répond pas :**
- Vérifier que SearXNG tourne : `curl http://localhost:8888/search?q=test&format=json`
- Le noeud d'erreur loggera le problème dans l'exécution N8N

**Timeout LLM :**
- Les noeuds LLM appellent `http://localhost:3000/api/llm/complete`, qui répond avec le stack actif (Ollama ou MLX)
- Vérifier le stack actif : `curl http://localhost:3000/api/health` (champ `stack`)
- Une réponse 503 pendant un benchmark est normale ; relancer le workflow après le benchmark
- Augmenter le timeout dans les noeuds HTTP Request si nécessaire

**Rien n'est stocké :**
- Vérifier que PharmaLLM tourne sur le port 3000
- Tester l'API directement : `curl -X POST http://localhost:3000/api/knowledge/ingest-text -H "Content-Type: application/json" -d '{"text":"test","source":"test"}'`
- Regarder les logs de l'exécution dans N8N pour voir à quelle étape ça bloque

**Token API PharmaLLM :**
- Les appels protégés (`/api/llm/complete`, `/api/knowledge/gaps/check-resolution`, `/api/dashboard/kb-health`) envoient `Authorization: Bearer {{ $env.PHARMALLM_API_TOKEN }}`
- Sans token configuré dans PharmaLLM, ces routes n'acceptent que les requêtes locales : n8n doit tourner sur la même machine
- Avec un token (`scripts/switch-stack.sh token`), démarrer n8n avec `PHARMALLM_API_TOKEN="$(cat data/run/api-token)"` et `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` pour que l'expression `$env` fonctionne
- Une réponse 401 signifie un token absent ou différent de celui de PharmaLLM
