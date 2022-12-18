# Vim Compose

Compose mail and other text on the web as markdown in vim.


## Installation

Vim Compose currently supports [chrome](https://chrome.google.com/webstore/detail/vim-compose/lafooengjljmipillledmadfcpannkbc) and [firefox nightly](https://addons.mozilla.org/de/firefox/addon/vim-compose/) on Linux.
In addition to the browser extension, you need to install a native host app.
First, make sure to install all dependencies: `vim`, `gnome-terminal`, `pandoc` and the [rust toolchain](https://rustup.rs/).
Now run the following to download and install the native host app:
```
git clone https://github.com/mbid/vim-compose
cd vim-compose
./install-native-host
```

## Usage

When you've focused a field that accepts text input, hit Ctrl-Space (firefox), Ctrl-Shift-E (chrome) or click the Vim Compose extension button in the toolbar.
This opens a new terminal running vim.
Whenver you save in vim, the contents of the file you're editing are copied to the browser.
Once you're done editing, [exit vim](https://stackoverflow.com/questions/11828270/how-do-i-exit-vim).
If the text box you're editing supports formatted input (e.g. most webmail clients such as Gmail), the text you enter in vim is interpreted as markdown.
