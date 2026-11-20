/** 截图隔离面板:从 src 拼装 PAGE,零网关进程。 */
import { createServer } from "node:http";
import { PAGE } from "./panel.js";

const port = Number(process.env.GENIE_PANEL_PORT || 7913);
const srv = createServer((req, res) => {
  if (req.url && req.url.startsWith("/assets/")) {
    res.writeHead(404, { "content-type": "text/javascript" });
    res.end("");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
srv.listen(port, "127.0.0.1", () => console.log(`panel-isolated listen ${port}`));
