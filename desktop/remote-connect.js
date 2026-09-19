"use strict";

const $ = (selector) => document.querySelector(selector);
const api = window.upmRemoteManager;
let connections = [];

function setStatus(message = "", type = "") {
  const node = $("#formStatus");
  node.textContent = message;
  node.className = `status${type ? ` ${type}` : ""}`;
}

function currentDraft() {
  return {
    id: $("#connectionId").value.trim(),
    name: $("#connectionName").value.trim(),
    url: $("#connectionUrl").value.trim(),
    rememberSession: $("#rememberSession").checked,
  };
}

function updateHttpWarning() {
  const raw = $("#connectionUrl").value.trim();
  $("#httpWarning").hidden = !/^http:\/\//i.test(raw);
}

function resetForm() {
  $("#connectionId").value = "";
  $("#connectionName").value = "";
  $("#connectionUrl").value = "";
  $("#rememberSession").checked = true;
  $("#saveBtn").textContent = "Save Connection";
  updateHttpWarning();
  setStatus();
}

function editConnection(connection) {
  $("#connectionId").value = connection.id;
  $("#connectionName").value = connection.name;
  $("#connectionUrl").value = connection.url;
  $("#rememberSession").checked = connection.rememberSession !== false;
  $("#saveBtn").textContent = "Update Connection";
  updateHttpWarning();
  $("#connectionName").focus();
}

function renderConnections() {
  const list = $("#connectionList");
  list.replaceChildren();
  if (!connections.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No Remote UPM connections saved yet.";
    list.append(empty);
    return;
  }

  for (const connection of connections) {
    const row = document.createElement("article");
    row.className = "connection";

    const info = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = connection.name;
    const url = document.createElement("div");
    url.className = "connection-url";
    url.textContent = connection.url;
    const meta = document.createElement("div");
    meta.className = "connection-meta";
    meta.textContent = connection.rememberSession
      ? "Login session may persist on this computer"
      : "Login session is discarded when UPM exits";
    info.append(title, url, meta);

    const actions = document.createElement("div");
    actions.className = "connection-actions";
    const connect = document.createElement("button");
    connect.textContent = "Connect";
    connect.addEventListener("click", async () => {
      connect.disabled = true;
      try {
        await api.connect(connection.id);
      } catch (error) {
        setStatus(error.message || String(error), "error");
      } finally {
        connect.disabled = false;
      }
    });
    const edit = document.createElement("button");
    edit.className = "secondary";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => editConnection(connection));
    const remove = document.createElement("button");
    remove.className = "danger";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      if (!confirm(`Remove ${connection.name}? Its saved remote browser session will also be cleared.`)) return;
      try {
        connections = await api.remove(connection.id);
        renderConnections();
        if ($("#connectionId").value === connection.id) resetForm();
      } catch (error) {
        setStatus(error.message || String(error), "error");
      }
    });
    actions.append(connect, edit, remove);
    row.append(info, actions);
    list.append(row);
  }
}

async function refresh() {
  connections = await api.list();
  renderConnections();
}

$("#connectionUrl").addEventListener("input", updateHttpWarning);
$("#resetBtn").addEventListener("click", resetForm);
$("#closeBtn").addEventListener("click", () => api.close());

$("#testBtn").addEventListener("click", async () => {
  setStatus("Testing Remote UPM…");
  $("#testBtn").disabled = true;
  try {
    const result = await api.probe(currentDraft());
    const authText = result.authEnabled
      ? `Authentication enabled${result.authenticated ? "; this session is already signed in" : ""}.`
      : "Authentication is not enabled on the remote host.";
    setStatus(`Connected to UPM at ${result.url}. ${authText}`, "success");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    $("#testBtn").disabled = false;
  }
});

$("#connectionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Saving…");
  $("#saveBtn").disabled = true;
  try {
    const result = await api.save(currentDraft());
    connections = result.connections;
    renderConnections();
    resetForm();
    setStatus(`Saved ${result.connection.name}.`, "success");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    $("#saveBtn").disabled = false;
  }
});

refresh().catch((error) => setStatus(error.message || String(error), "error"));
