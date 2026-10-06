// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The pages a human sees: the authorize page, the replacement result page,
 * the passkey enrollment page and a plain error page. The only script is inline and pinned by hash in the
 * CSP; options reach it as a JSON data block, which a CSP does not execute. No
 * page sets or reads a cookie.
 */

import crypto from "node:crypto";
import type { Scope } from "./config";
import { SCOPE_WORDS } from "./texts";

export type Page = { status: number; headers: Record<string, string>; body: string };

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;color:#111}
h1{font-size:1.4rem}.claim{color:#555}.verified{color:#166534}.warn{border-left:4px solid #b45309;padding:.5rem 1rem;background:#fffbeb}
.reason{border-left:4px solid #b91c1c;padding:.5rem 1rem;background:#fef2f2}
label{display:block;margin:1rem 0 .25rem}input[type=text]{font:inherit;padding:.4rem;width:100%;box-sizing:border-box}
button{font:inherit;padding:.5rem 1rem;margin:1rem .5rem 0 0}#status{color:#b91c1c}`;

const B64U = `const toBuf=(s)=>{s=s.replace(/-/g,"+").replace(/_/g,"/");s+="=".repeat((4-s.length%4)%4);return Uint8Array.from(atob(s),(c)=>c.charCodeAt(0));};
const fromBuf=(b)=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
const creds=(list)=>(list||[]).map((c)=>({type:"public-key",id:toBuf(c.id),transports:c.transports}));
const status=document.getElementById("status");`;

const AUTHORIZE_SCRIPT = `${B64U}
const options=JSON.parse(document.getElementById("webauthn-options").textContent);
const form=document.getElementById("approve");
form.addEventListener("submit",async(event)=>{
event.preventDefault();status.textContent="";
try{
const credential=await navigator.credentials.get({publicKey:{challenge:toBuf(options.challenge),rpId:options.rpId,timeout:options.timeout,userVerification:"required",allowCredentials:creds(options.allowCredentials)}});
const r=credential.response;
document.getElementById("assertion").value=JSON.stringify({id:credential.id,rawId:fromBuf(credential.rawId),type:credential.type,clientExtensionResults:credential.getClientExtensionResults(),response:{authenticatorData:fromBuf(r.authenticatorData),clientDataJSON:fromBuf(r.clientDataJSON),signature:fromBuf(r.signature),userHandle:r.userHandle?fromBuf(r.userHandle):undefined}});
form.submit();
}catch(error){status.textContent="The passkey check did not finish: "+error.message;}
});`;

const ENROLL_SCRIPT = `${B64U}
const secret=location.hash.slice(1);
document.getElementById("create").addEventListener("click",async()=>{
status.textContent="";
try{
const started=await fetch("/enroll/options",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({secret})});
const offer=await started.json();
if(!started.ok){status.textContent=offer.message;return;}
let approval={};
if(offer.assertion){
const a=offer.assertion;
const existing=await navigator.credentials.get({publicKey:{challenge:toBuf(a.challenge),rpId:a.rpId,timeout:a.timeout,userVerification:"required",allowCredentials:creds(a.allowCredentials)}});
const e=existing.response;
approval={assertion_challenge:a.challenge,assertion:{id:existing.id,rawId:fromBuf(existing.rawId),type:existing.type,clientExtensionResults:existing.getClientExtensionResults(),response:{authenticatorData:fromBuf(e.authenticatorData),clientDataJSON:fromBuf(e.clientDataJSON),signature:fromBuf(e.signature),userHandle:e.userHandle?fromBuf(e.userHandle):undefined}}};
}
const o=offer.options;
const credential=await navigator.credentials.create({publicKey:{challenge:toBuf(o.challenge),rp:o.rp,user:{id:toBuf(o.user.id),name:o.user.name,displayName:o.user.displayName},pubKeyCredParams:o.pubKeyCredParams,timeout:o.timeout,attestation:o.attestation,excludeCredentials:creds(o.excludeCredentials),authenticatorSelection:o.authenticatorSelection}});
const r=credential.response;
const finished=await fetch("/enroll/finish",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...approval,secret,challenge:o.challenge,label:document.getElementById("label").value,response:{id:credential.id,rawId:fromBuf(credential.rawId),type:credential.type,clientExtensionResults:credential.getClientExtensionResults(),response:{attestationObject:fromBuf(r.attestationObject),clientDataJSON:fromBuf(r.clientDataJSON),transports:r.getTransports?r.getTransports():[]}}})});
const done=await finished.json();
status.textContent=done.message;
}catch(error){status.textContent="The passkey was not created: "+error.message;}
});`;

function sha256Source(source: string): string {
  return `'sha256-${crypto.createHash("sha256").update(source).digest("base64")}'`;
}

function csp(script: string | null): string {
  return [
    "default-src 'none'",
    script === null ? "script-src 'none'" : `script-src ${sha256Source(script)}`,
    `style-src ${sha256Source(STYLE)}`,
    "connect-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join("; ");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON inside a `<script type="application/json">`: `<` can never close the element. */
function dataBlock(id: string, value: unknown): string {
  return `<script type="application/json" id="${id}">${JSON.stringify(value).replace(/</g, "\\u003c")}</script>`;
}

function page(status: number, title: string, main: string, script: string | null): Page {
  const body = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>`,
    main,
    script === null ? "" : `<script>${script}</script>`,
    "</body></html>"
  ].join("\n");
  return {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": csp(script),
      "referrer-policy": "no-referrer"
    },
    body
  };
}

export function errorPage(status: number, title: string, message: string): Page {
  return page(status, title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`, null);
}

/**
 * The name prefill on the authorize page: lowercased, runs outside
 * `[a-z0-9-]` turned into `-`, leading non-letters dropped. Only the request's
 * client_id host feeds it, never a stored grant name.
 */
export function nameSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z]+/, "");
}

export type AuthorizePageInput = {
  challenge: string;
  /** As the request named it; unverified until the passkey, unless hosted. */
  clientId: string;
  /** As the request named it; unverified until the passkey, unless hosted. */
  redirectUri: string;
  /** A document hosted by this duoduo, whose redirect GET already checked. */
  hosted: boolean;
  scopes: readonly Scope[];
  name: string;
  /** The reason a submitted name was refused, after a verified passkey. */
  refusal?: string;
  rpId: string;
  timeoutMs: number;
  credentialIds: ReadonlyArray<{ id: string; transports?: string[] }>;
};

export function authorizePage(input: AuthorizePageInput): Page {
  const main = [
    `<h1>Connect an app to duoduo</h1>`,
    `<p>An app asks to connect.</p>`,
    ...(input.hosted
      ? [
          `<p>App: <b>${escapeHtml(input.clientId)}</b> <span class="verified">(a client document hosted by this duoduo)</span></p>`,
          `<p>Returns to: <b>${escapeHtml(input.redirectUri)}</b> <span class="verified">(verified: that document lists it)</span></p>`,
          `<p class="claim">This client document was added on the duoduo host and lists only` +
            ` addresses on the owner's own device. After your passkey the browser goes to that` +
            ` address with a code; if nothing answers there, copy the whole address from the` +
            ` address bar back to the app.</p>`
        ]
      : [
          `<p>App: <b>${escapeHtml(input.clientId)}</b> <span class="claim">(not verified yet)</span></p>`,
          `<p>Returns to: <b>${escapeHtml(input.redirectUri)}</b> <span class="claim">(not verified yet)</span></p>`,
          `<p class="claim">Several apps can share one app address; the return address tells you which` +
            ` one asks. After your passkey, duoduo fetches the app address and checks that it lists` +
            ` this return address; if it does not, nothing is approved.</p>`
        ]),
    `<p>It will be able to:</p><ul>`,
    ...input.scopes.map((scope) => `<li>${escapeHtml(SCOPE_WORDS[scope])}</li>`),
    `</ul>`,
    `<p class="warn">Approve only a connection you started yourself, just now. Approving connects` +
      ` whoever started this request. If the name below belongs to an assistant already` +
      ` connected through this same app address, approving replaces that assistant's connection;` +
      ` a name another app's assistant holds is refused.</p>`,
    input.refusal === undefined ? "" : `<p class="reason">${escapeHtml(input.refusal)}</p>`,
    `<form id="approve" method="post" action="/authorize">`,
    `<input type="hidden" name="challenge" value="${escapeHtml(input.challenge)}">`,
    `<input type="hidden" name="assertion" id="assertion" value="">`,
    `<label for="name">Connection name: duoduo records this app's work under it</label>`,
    `<input type="text" id="name" name="name" value="${escapeHtml(input.name)}" autocomplete="off"` +
      ` spellcheck="false" pattern="[a-z][a-z0-9\\-]*" required>`,
    `<button type="submit">Approve with passkey</button>`,
    `</form>`,
    `<form method="post" action="/authorize">`,
    `<input type="hidden" name="challenge" value="${escapeHtml(input.challenge)}">`,
    `<input type="hidden" name="deny" value="1">`,
    `<button type="submit">Deny</button>`,
    `</form>`,
    `<p id="status" role="status"></p>`,
    dataBlock("webauthn-options", {
      challenge: input.challenge,
      rpId: input.rpId,
      timeout: input.timeoutMs,
      allowCredentials: input.credentialIds
    })
  ].join("\n");
  return page(200, "Connect an app to duoduo", main, AUTHORIZE_SCRIPT);
}

/**
 * The approval replaces an assistant of the same client. Shown only after the
 * passkey; its one link continues the OAuth redirect with the code.
 */
export function replacedPage(input: { name: string; location: string }): Page {
  const main = [
    `<h1>Approved</h1>`,
    `<p>"${escapeHtml(input.name)}" is already an assistant connected through this app. This approval` +
      ` replaces it: its old connection stops working when the app finishes connecting, and the` +
      ` name and its records continue.</p>`,
    `<p><a href="${escapeHtml(input.location)}">Continue to the app</a></p>`
  ].join("\n");
  return page(200, "Approved", main, null);
}

export function enrollPage(): Page {
  const main = [
    `<h1>Add a passkey for duoduo</h1>`,
    `<p>This passkey approves apps that connect to duoduo. Create it on a device you keep.` +
      ` If a passkey is already enrolled, the browser first asks for that one to approve the new one.</p>`,
    `<label for="label">Label (optional), for example "phone"</label>`,
    `<input type="text" id="label" autocomplete="off">`,
    `<button type="button" id="create">Create passkey</button>`,
    `<p id="status" role="status"></p>`
  ].join("\n");
  return page(200, "Add a passkey for duoduo", main, ENROLL_SCRIPT);
}
