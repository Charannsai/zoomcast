const { app, screen } = require('electron');
app.whenReady().then(() => {
    const displays = screen.getAllDisplays();
    const pt = screen.getCursorScreenPoint();
    console.log(JSON.stringify({ pt, displays }));
    app.quit();
});
