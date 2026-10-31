param(
    [string[]]$Architectures=@('arm64-v8a','armeabi-v7a','x86_64'),
    [string]$GoPath='',
    [string]$NdkPath=''
)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
if(!$GoPath){$GoPath=Join-Path $projectRoot '.tools/go/bin/go.exe'}
if(!$NdkPath){$NdkPath=Join-Path $projectRoot '.tools/android-ndk-r27c'}
$source=Join-Path $projectRoot '.tools/cloudflared-src'
$llvm=Join-Path $NdkPath 'toolchains/llvm/prebuilt/windows-x86_64'
if(!(Test-Path $GoPath)){throw 'Go 1.27.3 is required.'}
if(!(Test-Path "$llvm/bin/clang.exe")){throw 'Android NDK r27c is required.'}
if(!(Test-Path "$source/go.mod")){throw 'Clone cloudflare/cloudflared tag 2026.10.5 into .tools/cloudflared-src first.'}
Copy-Item "$projectRoot/native/cloudflared/pocket_dns_android.go" "$source/cmd/cloudflared/pocket_dns_android.go" -Force
$env:GOCACHE=Join-Path $projectRoot '.tools/go-cache'
$env:GOMODCACHE=Join-Path $projectRoot '.tools/go-mod-cache'
$env:GOPATH=Join-Path $projectRoot '.tools/go-work'
$env:GOTMPDIR=Join-Path $projectRoot '.tools/go-tmp'
New-Item -ItemType Directory -Force $env:GOCACHE,$env:GOMODCACHE,$env:GOPATH,$env:GOTMPDIR | Out-Null
$env:GOOS='android';$env:CGO_ENABLED='1';$env:GOFIPS140='off';$env:GOTOOLCHAIN='local'
Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:ALL_PROXY -ErrorAction SilentlyContinue
& (Join-Path (Split-Path $GoPath) 'gofmt.exe') -w "$source/cmd/cloudflared/pocket_dns_android.go"
Push-Location $source
try {
    foreach($abi in $Architectures){
        $target=switch($abi){'arm64-v8a'{$env:GOARCH='arm64';'aarch64-linux-android26'}'armeabi-v7a'{$env:GOARCH='arm';$env:GOARM='7';'armv7a-linux-androideabi26'}'x86_64'{$env:GOARCH='amd64';'x86_64-linux-android26'}default{throw 'Unsupported ABI'}}
        $env:CC="$llvm/bin/clang.exe --target=$target --sysroot=$llvm/sysroot"
        $destination=Join-Path $projectRoot "app/src/main/jniLibs/$abi"
        New-Item -ItemType Directory -Force $destination | Out-Null
        & $GoPath build -mod=readonly -trimpath -buildvcs=false -buildmode=pie -ldflags '-s -w -X main.Version=2026.10.5-pocket -X main.BuildType=android -linkmode external -extldflags "-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384"' -o "$destination/libcloudflared.so" ./cmd/cloudflared
        if($LASTEXITCODE){throw "cloudflared build failed for $abi"}
    }
} finally {Pop-Location}
