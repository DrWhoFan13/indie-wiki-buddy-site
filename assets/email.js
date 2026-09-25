const user = "kevinpayravi";
const host = "gmail.com";
const link = document.getElementById("email");
link.href = `mailto:${user}@${host}`;
link.textContent = `${user}@${host}`;
