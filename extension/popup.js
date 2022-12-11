const hostName = "com.google.chrome.example.echo";
const port = chrome.runtime.connectNative(hostName);

port.onMessage.addListener((message) => {
  date = message;
  console.log(`Got date: ${date}`);
  document.getElementById("date").innerText = date;
});

setInterval(() => {
  port.postMessage({"action": "givedate"});
  console.log("Asking for date");
}, 1000);
