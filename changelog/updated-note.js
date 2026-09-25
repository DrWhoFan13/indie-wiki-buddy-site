// IWB extension opens this page with ?updated=1 after an update
// Toggles display of an update note
if (new URLSearchParams(location.search).get("updated")) {
    document.getElementById("updated-note").style.display = "block";
}
