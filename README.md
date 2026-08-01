# 🛒 Makiti — MCP Shopping Assistant

**Makiti** est un serveur MCP (Model Context Protocol) qui agit comme assistant shopping intelligent.
Il s’appuie sur **Hound** pour chercher le web et fournit des outils MCP pour :

- 🔍 rechercher des produits,
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
Rechercher des produits avec filtres de prix, marque, retailer, condition.

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
Trouver les deals/promo actifs pour un produit ou une catégorie.

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
