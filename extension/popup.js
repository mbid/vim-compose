const hostName = "com.google.chrome.example.echo";
const port = chrome.runtime.connectNative(hostName);

port.onMessage.addListener((message) => {
  console.log(`Got message: ${message}`);
  document.getElementById("date").innerText = message.date;
});

setInterval(() => {
  port.postMessage({"action": "givedate"});
  console.log("Asking for date");
}, 1000);
