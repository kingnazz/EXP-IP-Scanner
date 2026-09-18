EXP IP Scanner __VERSION__ - Portable Edition for Windows __ARCH__
=================================================================

A network scanner for everyday IT work. No installer, no setup, no
administrator rights.


GETTING STARTED
---------------

1. Extract this ZIP to a folder.
2. Run "EXP IP Scanner.exe".
3. The network you are on is detected automatically. Press Scan.
4. Right-click a device for Remote Desktop, file shares, SSH or its web
   interface. Double-click one for its full details.
5. Export a CSV for anything you need to keep.

Windows may show an "unknown publisher" warning the first time. See
SIGNING below.


WHAT IT WRITES, AND WHERE
-------------------------

Scan results are held in memory for as long as the window is open and are
written to disk only when you export a CSV yourself. There is no database
and no scan history, so closing the application ends the session. That is
deliberate: the same copy of this tool gets pointed at many unrelated
customer networks, and one customer's device list has no business
surviving into the next site visit.

The only thing kept between launches is your own interface preferences --
theme, column widths, row height and scan settings -- in:

  %LOCALAPPDATA%\com.exp.ipscanner\portable-webview\

A dedicated folder, so a portable copy and an installed copy never share
preferences and can run side by side. Nothing about any network you have
scanned is stored there.


EXTRACTED FOLDER, USB AND READ-ONLY SHARES
------------------------------------------

The folder containing the executable is never written to. Running from a
read-only share, a USB stick, a synced OneDrive folder or a technician
tools folder is supported.

Two portable copies may run at once, and a portable copy may run
alongside an installed one.


UPDATING
--------

The portable edition never updates itself. There is no updater in this
build at all -- it is compiled without one, rather than having the button
hidden.

1. Close the application.
2. Download the latest portable ZIP.
3. Extract it and run the new executable.

Do not replace the executable while it is running.


REMOVING
--------

Close the application and delete the extracted folder. There is no
uninstaller, service, Start-menu entry or scheduled task. To remove the
preferences as well, delete the folder named under WHAT IT WRITES above.


REQUIREMENTS
------------

* Windows 10 or Windows 11, __ARCH__.
* The Microsoft Edge WebView2 Runtime.

WebView2 ships with Windows 11 and with current Windows 10, so it is
almost always already present. This ZIP installs no system software. If
it is missing, install "Microsoft Edge WebView2 Runtime" from Microsoft
and run the application again.


SIGNING
-------

This build is not code-signed with a paid publisher certificate, so
Windows SmartScreen may show an unknown-publisher warning. Choose "More
info", then "Run anyway". Download only from the official release page
and check the published SHA-256 checksum.


PRIVACY
-------

Scanning happens on this computer. Results are not uploaded anywhere,
there is no account, no telemetry and no analytics, and the portable
edition makes no update check.

One request does leave this computer: the network summary at the top of
the window looks up the address this network appears as from outside, by
asking a plain-text service what your address is. It sends nothing about
you, your network or your scans, and it can be turned off in Settings.

Full notes: https://kingnazz.github.io/EXP-IP-Scanner/privacy.html


SCOPE
-----

This is a read-only network discovery and administration utility. Scan
only networks you are authorised to inspect.


MORE
----

Downloads and documentation: https://kingnazz.github.io/EXP-IP-Scanner/
Source and releases:         https://github.com/kingnazz/EXP-IP-Scanner

MIT licensed.
