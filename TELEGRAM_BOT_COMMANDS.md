# Ideomotion Server Telegram Admin Bot

Set these environment variables on the server:

- `BOT_TOKEN` — Telegram bot token from BotFather
- `TG_ADMIN_IDS` — comma-separated Telegram numeric user IDs allowed to use the bot
- `ADMIN_API_KEY` — admin API key for HTTP admin endpoints
- `MONGO_URI` — MongoDB connection URI

## Commands

### Help

- `/help` — show all commands
- `/stats` — database counts

### License management

- `/gen COUNT DAYS` — generate normal license keys
- `/genhidden COUNT DAYS` — generate license keys with AI Tools/promo/bell hidden
- `/license KEY` — show one license status
- `/searchlicense TEXT` — search license keys
- `/resetlicense KEY` — unbind device only
- `/deactivate KEY` — unbind device and activation date
- `/dellicense KEY` — permanently delete a license
- `/extend KEY DAYS` — add days to license duration
- `/setdays KEY DAYS` — set license duration days
- `/hideaitools KEY` — hide AI Tools, bell notification, and promo popup product list for this license
- `/showaitools KEY` — show AI Tools, bell notification, and promo popup product list for this license

### Product management

- `/productlist` — list all products
- `/productadd name | price | imageUrl | buyLink | description | sortOrder` — add product
- `/productremove ID_OR_NAME` — permanently delete product
- `/productoff ID_OR_NAME` — hide product from public `/api/products`
- `/producton ID_OR_NAME` — show product again
- `/productprice ID_OR_NAME | new price` — update price
- `/productlink ID_OR_NAME | new buy link` — update buy link

Example:

```text
/productadd Canva Pro | $5 | https://example.com/canva.png | https://example.com/buy | Monthly subscription | 1
```

### Extension settings

- `/setwhatsapp URL` — set Buy License link used by extension expiry popup
- `/setexpirydays DAYS` — set expiry warning threshold
- `/settings` — show current extension settings

### Extension update control

- `/setupdate VERSION | UPDATE_URL | force:true/false | how to update text` — set and enable update screen config
- `/updateon` — enable server-controlled update screen
- `/updateoff` — disable server-controlled update screen
- `/updatestatus` — show update config

Example:

```text
/setupdate 1.2.0 | https://example.com/new-extension.zip | force:true | Download ZIP, extract it, open chrome://extensions, remove old version, then Load unpacked.
```
