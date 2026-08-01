# 🛒 Makiti — MCP Shopping Assistant

**Makiti** est un serveur MCP (Model Context Protocol) qui agit comme assistant shopping intelligent.
Il s’appuie sur **Hound** pour chercher le web et scraper les retailers, et fournit des outils MCP pour :

- 🔍 rechercher des produits,
- 🏷️ trouver le meilleur prix sur les retailers canadiens,
- ⚖️ comparer des items,
- 💰 trouver les meilleurs deals,
- 📈 estimer l’historique de prix.

---

## 🚀 Installation

```bash
git clone https://github.com/seasayDev/makiti-mcp.git
cd makiti-mcp
npm install
```

---

## ⚙️ Configuration requise

| Dépendance | Description |
|---|---|
| **Node.js >= 18** | Runtime requis |
| **Hound MCP** | Serveur MCP de recherche web (wrapper Hermes) |
| **Hermes Agent** | Pour consommer les outils Makiti via MCP |

### Architecture

Makiti ne parle pas à Hound par HTTP : il **spawn Hound en sous-processus** et
communique en **JSON-RPC stdio** (protocole MCP), exactement comme le fait Hermes.
Le chemin du wrapper Hound est configurable via la variable d'environnement
`HOUND_WRAPPER` (défaut : `/data/data/com.termux/files/home/.hermes/scripts/hound-wrapper.sh`).

```
[ Agent / Hermes ] ──stdio──> [ Makiti MCP ] ──spawn──> [ Hound MCP ] ──> web
```

---

## 🛠️ Outils disponibles

### `product_search`
Rechercher des produits sur le web avec filtres de prix, marque, retailer, condition.
Les résultats sont **triés du moins cher au plus cher** quand un prix est détecté.

```json
{
  "query": "iPhone 15",
  "max_price": 1200,
  "brand": "Apple",
  "retailer": "amazon.ca",
  "condition": "new",
  "limit": 10
}
```

### `find_best_price` ⭐ (nouveau)
**Scraper directement les pages de recherche des retailers canadiens** (Amazon.ca, Walmart.ca…)
pour trouver le prix le plus bas réel, lu en direct sur les sites.
Plus fiable que `product_search` car il lit les pages produits elles-mêmes.

```json
{
  "query": "usb flash drive 128gb",
  "retailers": ["amazon.ca", "walmart.ca"],
  "limit": 5
}
```

Retailers supportés : `amazon.ca`, `walmart.ca`, `bestbuy.ca`, `canadiantire.ca`, `staples.ca`, `newegg.ca`.
> ⚠️ Best Buy Canada bloque le scraping automatisé (HTTP 403) — les erreurs sont listées dans la réponse.

### `product_compare`
Comparer deux produits côte à côte : specs, prix, verdict.

```json
{
  "product_a": "iPhone 15",
  "product_b": "Samsung Galaxy S24",
  "category": "smartphone",
  "budget": 1100
}
```

### `find_deals`
Trouver les deals/promo actifs pour un produit ou une catégorie (filtré sur la région Canada).

```json
{
  "query": "Nike running shoes",
  "region": "Canada",
  "retailer": "amazon.ca",
  "limit": 10
}
```

### `price_history`
Suivre/estimer l’historique de prix d’un produit sur plusieurs retailers.

```json
{
  "product": "PlayStation 5",
  "retailers": ["amazon.ca", "bestbuy.ca", "walmart.ca"],
  "days_back": 90
}
```

### `makiti_guide`
Obtenir des conseils d’utilisation selon ton scénario shopping.

```json
{
  "scenario": "acheter un laptop sous 800 CAD"
}
```

---

## 🧠 Leçons apprises (retour d'expérience réel)

Makiti a été mis à l'épreuve sur une vraie recherche (« meilleur prix clé USB 128GB Canada »).
Voici ce que cette expérience a révélé, et comment le code a été corrigé.

### Leçon 1 — Les filtres `site:` tuent les recherches Hound
**Problème :** `product_search` générait des requêtes comme `USB flash drive 128GB site:amazon.ca price` →
**0 résultat** sur tous les moteurs de Hound.
**Cause :** les opérateurs `site:` combinés à des requêtes longues font échouer les moteurs.

**Correction :**
- plus aucun `site:` dans les requêtes ;
- les noms de retailers sont convertis en mots-clés (`amazon.ca` → `amazon canada`) ;
- les requêtes sont gardées **courtes** (`< 8 mots`).

### Leçon 2 — Fallback automatique des moteurs de recherche
**Problème :** pendant la session, les moteurs `google` et `brave` étaient bloqués
(`engine_blocked`), donnant 0 résultat pendant plusieurs minutes.

**Correction :** `hound-client.js` implémente un **fallback en 3 paliers** :
1. `google, brave, duckduckgo, yahoo`
2. `duckduckgo, yahoo, qwant, mojeek`
3. `startpage, bing`

Si un palier renvoie 0 résultat **et** des moteurs bloqués, on passe au palier suivant.

### Leçon 3 — La recherche web seule ne suffit pas : il faut scraper les retailers
**Problème :** les résultats web donnent des liens de blogs/deals, pas de prix fiables.
**La méthode gagnante :** le **fetch direct** des pages de recherche des retailers
(`amazon.ca/s?k=...`, `walmart.ca/en/search?q=...`) a donné les vrais prix en CAD,
y compris les promotions en cours (Kingston 64GB à 13,97$ Walmart, PNY 128GB à 26,08$ Amazon).

**Correction :** nouvel outil `find_best_price` qui scrappe Amazon.ca et Walmart.ca en parallèle
et extrait (produit, prix) avec une heuristique ligne par ligne.

### Leçon 4 — Les résultats « deals » partent en vrille géographique
**Problème :** `find_deals` sur « USB flash drive » renvoyait des deals **hotukdeals (UK)**
et des sites pakistanais.

**Correction :** filtrage géographique — on garde les hits contenant des indices canadiens
(`.ca`, `Canada`, `CAD`, `québec`, `redflagdeals`, `slickdeals`…) et on élimine les indices
étrangers (`hotukdeals`, `.co.uk`, `pakistan`, `karachi`, `indiamart`…).

### Leçon 5 — Le parsing de prix est un champ de mines
**Problème :** les pages retailers mélangent prix réels (`Now $13.97`) et bruit
(`You save $6.02`, `$890` sans décimales, `Up to $15`, headers markdown `##`).

**Correction (heuristique actuelle) :**
- les lignes `You save $X` ne fournissent **jamais** un prix ;
- on privilégie les prix **avec décimales** (`$13.97`) ;
- on ignore la navigation, les headers markdown, `More buying choices`, `List:`, `You pay` ;
- les titres sont nettoyés (`...284.6786 out of 5 stars. 28 reviews` → nom seul).

### Leçon 6 — La fraîcheur compte
Les prix bougent vite. Toutes les réponses rappellent que les prix sont **relevés à l'instant du fetch**
et doivent être vérifiés sur la page produit avant achat (taxes/livraison non incluses).

---

## 🗺️ Roadmap (améliorations futures)

- [ ] **Parsing JSON-LD/structured data** des pages retailers (au lieu de l'heuristique lignes) pour des prix exacts + URLs produits.
- [ ] **Contournement Best Buy** via le browser stealthy de Hound (actions click/form) — actuellement bloqué 403.
- [ ] **`price_alert`** — outil cron qui surveille un produit et notifie quand le prix passe sous un seuil.
- [ ] **Cache prix par produit** (TTL court) pour éviter de refrapper les retailers à chaque appel.
- [ ] **Support USD→CAD** pour les retailers américains (conversion + droits de douane indicatifs).
- [ ] **Détection de taxes/livraison** par province depuis les pages produit.
- [ ] **`compare_retailers`** — outil dédié qui croise les prix d'un même modèle sur 4+ retailers.

---

## 📦 Enregistrement dans Hermes

Dans `~/.hermes/config.yaml`, ajoute :

```yaml
mcp_servers:
  makiti:
    command: node
    args: ["/chemin/absolu/vers/makiti-mcp/server.js"]
```

Puis redémarre Hermes :

```bash
hermes gateway restart   # depuis un shell Termux, pas depuis le chat
```

Vérification :

```bash
hermes mcp list          # makiti doit apparaître ✓ enabled
hermes mcp test makiti   # ✓ Connected + tools discovered
```

---

## 🧪 Développement / test

```bash
# Vérifier le handshake MCP + un outil réel
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"product_search","arguments":{"query":"iPhone 15","limit":3}}}' \
  | timeout 100 node server.js
```

> ⚠️ Hound démarre en ~15 s au premier appel (proot Ubuntu). Patience sur le premier `tools/call`.

---

## 🔧 Scripts npm

```bash
npm start   # lancer le serveur MCP (alias node server.js)
```

---

## 📄 License

MIT © seasayDev
