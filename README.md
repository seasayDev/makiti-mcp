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
| **Hound MCP** | Serveur de recherche web tournant sur `http://localhost:8001` |
| **Hermes Agent** | Pour consommer les outils Makiti via MCP |

### Lancer Hound

Makiti nécessite Hound en local. Assurez-vous qu’il écoute sur le port `8001`.

```bash
# Exemple (selon ta config Hound)
cd ~/projects/hound-mcp
npm run start
# → http://localhost:8001
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
  - name: makiti
    command: node
    args: ["/chemin/absolu/vers/makiti-mcp/server.js"]
    env:
      HOUND_URL: "http://localhost:8001"
```

Puis redémarre Hermes :

```bash
hermes restart
```

---

## 🧪 Test rapide

```bash
# Vérifier que le serveur répond
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node server.js
```

---

## 🔧 Scripts npm

```bash
npm start          # lancer le serveur MCP
npm test           # placeholder (ajouter des tests plus tard)
```

---

## 📄 License

MIT © seasayDev
