#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2019 */

var jpickle = require("jpickle");
var fs = require("fs");
var os = require("os");
var path = require("path");
var request = require("request-promise-native");
var { JSDOM } = require("jsdom");
var readline = require("readline");

// require("request-debug")(request);

function waitForStdin() {
  return new Promise((resolve) => {
    let lines = [];
    let rli = readline.createInterface({ input: process.stdin, });

    rli.on("line", line => lines.push(line));
    rli.once("close", () => {
      resolve(lines);
    });
  });
}


class AMOSession {
  constructor() {
    this.jar = request.jar();
    this.request = request.defaults({ jar: this.jar });
  }

  loadSessionId(id) {
    let cookie = this.request.cookie("sessionid=" + id);
    this.jar.setCookie(cookie, "https://addons-internal.prod.mozaws.net");
  }

  loadPythonCookies(cookiepath) {
    var cookiedata = jpickle.loads(fs.readFileSync(cookiepath, "utf-8"));
    for (let [name, value] of Object.entries(cookiedata)) {
      let cookie = this.request.cookie(`${name}=${value}`);
      this.jar.setCookie(cookie, "https://addons-internal.prod.mozaws.net");
    }
  }

  async loadUserAdminPage(userId) {
    let document = await this.request({
      uri: `https://addons-internal.prod.mozaws.net/en-US/admin/models/users/userprofile/${userId}/change/`,
      followRedirect: false,
      transform: (body) => {
        return new JSDOM(body).window.document;
      }
    }).catch((response) => {
      if (response.statusCode == 302) {
        throw new Error("Authorization Error");
      } else {
        throw response;
      }
    });

    let form = {};
    for (let node of document.querySelectorAll("form input")) {
      if (node.getAttribute("type") == "submit") {
        continue;
      }

      form[node.getAttribute("name")] = node.getAttribute("value") || "";
    }

    return new UserAdminPage(this, userId, form);
  }
}

class UserAdminPage {
  constructor(session, userId, data) {
    this.session = session;
    this.userId = userId;
    this.data = data;
  }

  async ban() {
    let response = await this.session.request({
      uri: `https://addons-internal.prod.mozaws.net/en-US/admin/models/users/userprofile/${this.userId}/ban/`,
      form: this.data,
      headers: { Referer: `https://addons-internal.prod.mozaws.net/en-US/admin/models/users/userprofile/${this.userId}/change/` },
      method: "POST",
      followRedirect: false,
      resolveWithFullResponse: true,
      simple: false
    });

    return response.headers["set-cookie"].some(cookie => {
      return (cookie.startsWith("messages") && cookie.includes("has been banned"));
    });
  }
}

(async function() {
  let session = new AMOSession();
  try {
    session.loadPythonCookies(path.join(os.homedir(), ".amo_cookie"));
  } catch (e) {
    console.error("Could not load session cookie from pyamo, please log in there");
    return;
  }

  let args = process.argv.slice(2);
  if (!process.stdin.isTTY && !args.length) {
    data = await waitForStdin();
  } else if (process.stdin.isTTY && args.length) {
    data = args;
  } else {
    console.log("Usage: cat user_ids | mozban");
    console.log("   or: mozban `cat user_ids`");
    return;
  }

  for (let id of data) {
    try {
      let user = await session.loadUserAdminPage(id);
      let banned = await user.ban();
      if (banned) {
        console.log("Banned " + id);
      } else {
        console.error(`Failed to ban ${id}: No successful response`);
        return;
      }
    } catch (e) {
      console.error(`Failed to ban ${id}: ${e.message}`);
      return;
    }
  }
})();
