# Publishing: Facebook directly, or through Publer

The Worker publishes what you approve on the review page, and the scheduled auto-posts you allow. It can send posts two ways. Choose with the `PUBLISHER` variable.

| | **Facebook directly** (`PUBLISHER=facebook`, default) | **Through Publer** (`PUBLISHER=publer`) |
|---|---|---|
| Setup | A Meta app and a never-expiring Page token (more steps, done once) | A Publer account with API access, its workspace ID and account IDs |
| Posts per day | No practical cap | **Capped per page per day by your Publer plan: Free 12, Professional 24, Business 36** (rolling 24 h) |
| API limit | Facebook's limits, far above what a scanner page uses | **100 calls per 2 minutes for your whole Publer account**, shared with anything else that uses it |
| Speed | Posted in a second or two | **Asynchronous:** upload the image, wait for the job, publish, wait again, then look up the new post (usually 5–20 s) |
| Updates to live posts | Yes. Edits you made on Facebook are detected first and kept. | Yes, but **edits made directly on Facebook can't be detected**: the next update from the bot replaces them. Edit on the review page instead. |
| Post link on the review page | Always | When Publer returns one |
| Other networks | Facebook only | Any network you add to `PUBLER_ACCOUNTS` that accepts long posts with an image |
| Prayer tracker (🙏) | Yes | Only if you also set `FB_PAGE_ID` and `FB_PAGE_TOKEN` |
| Cost | Free | Your Publer plan |

**Choose Publer if** you can't or won't set up a Meta app, you already pay for Publer, or you want the same posts on several networks. **Stay with Facebook directly if** your page is busy, since storm nights can easily exceed 24 posts. Facebook directly is also the only way to keep edits you make on Facebook.

## Setting up Publer
1. In Publer, create an API key (it needs the **posts** and **media** scopes) and find your workspace ID and the account ID of each page to post to.
2. On the Worker:
   - Secret: `PUBLER_KEY`.
   - Variables:
     - `PUBLISHER` = `publer`
     - `PUBLER_WORKSPACE` = the workspace ID
     - `PUBLER_ACCOUNTS` = account IDs, comma-separated
     - `PUBLER_DAILY_LIMIT` = your plan's posts per page per day (12, 24 or 36; default 24)
3. Open `/status`: it should show `publer: ok (N account(s), daily limit …)`.

## How it behaves
- **Publishing:** the map image is imported into Publer from the image Worker's URL. The post then goes out to every account in `PUBLER_ACCOUNTS`. If the image can't be imported, the post goes out as text only.
- **Daily limit:** the Worker counts posts it published through Publer in the last 24 hours. At `PUBLER_DAILY_LIMIT` it refuses further publishes with "Publer daily limit reached". Drafts wait on the review page, and a due auto-post is marked failed so you can publish it later. This stops Publer from rejecting posts silently mid-incident.
- **Rate limit:** a 429 from Publer shows as "Publer rate limit… try again in a couple of minutes". Nothing is lost; the post stays a draft.
- **Live updates:** each update edits the post on every account through Publer. If Publer didn't return the post's ID after publishing, updates can't reach that post. The review page shows the error; edit that post on the network itself.

## Networks to leave out
- **X (Twitter):** posts are usually longer than 280 characters, so X would reject them. Use the review page's "Post to X" box instead.
- **Instagram:** needs an image on every post, and links aren't clickable. Leave it out unless every post has a map image.
