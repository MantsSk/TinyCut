; Inno Setup script for the TinyCutOpus Windows installer. Compiled by desktop/build.py:
;   ISCC /DAppVersion=1.0.0 /DRoot=<repo> desktop\windows\TinyCutOpus.iss
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Root
  #define Root "..\.."
#endif

[Setup]
AppId={{6C1E2A7B-4F3D-4E8A-9B1C-7A2D5E9F0B13}
AppName=TinyCutOpus
AppVersion={#AppVersion}
AppPublisher=TinyCutOpus
DefaultDirName={autopf}\TinyCutOpus
DisableProgramGroupPage=yes
; Per-user install by default (no admin prompt); users can choose all-users.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#Root}\dist
OutputBaseFilename=TinyCutOpus-{#AppVersion}-windows-x64-setup
SetupIconFile={#Root}\desktop\icon.ico
UninstallDisplayIcon={app}\TinyCutOpus.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#Root}\dist\TinyCutOpus\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Root}\build\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: NeedsWebView2

[Icons]
Name: "{autoprograms}\TinyCutOpus"; Filename: "{app}\TinyCutOpus.exe"
Name: "{autodesktop}\TinyCutOpus"; Filename: "{app}\TinyCutOpus.exe"; Tasks: desktopicon

[Run]
; The editor UI runs in Microsoft Edge WebView2 (built into Windows 11; installed here if missing).
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing Microsoft Edge WebView2…"; Check: NeedsWebView2
Filename: "{app}\TinyCutOpus.exe"; Description: "{cm:LaunchProgram,TinyCutOpus}"; Flags: nowait postinstall skipifsilent

[Code]
const WebView2Key = '\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasVersion(Root: Integer; Key: String): Boolean;
var V: String;
begin
  Result := RegQueryStringValue(Root, Key, 'pv', V) and (V <> '') and (V <> '0.0.0.0');
end;

function NeedsWebView2: Boolean;
begin
  Result := not (HasVersion(HKLM, 'SOFTWARE\WOW6432Node' + WebView2Key) or
                 HasVersion(HKLM, 'SOFTWARE' + WebView2Key) or
                 HasVersion(HKCU, 'Software' + WebView2Key));
end;
