
$ErrorActionPreference = "Stop"

$baseUrl = "http://localhost:5001/api/v1"
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

# Enter password securely; it won't be echoed in the terminal.
$securePassword = Read-Host "Staging test account password" -AsSecureString
$testPassword = [System.Net.NetworkCredential]::new("", $securePassword).Password

# Existing staging test data — do not generate new IDs.
$invoiceId = "00b61f59-608a-48bd-9eff-133c022e7511"
$idempotencyKey = "e2e-payment-20261116193007"

try {
    # 1. Login
    Write-Host "`n1. Logging in..."

    $loginBody = @{
        email = "owner-e2e-2026@example.com"
        password = $testPassword
    } | ConvertTo-Json

    Invoke-RestMethod `
        -Uri "$baseUrl/auth/login" `
        -Method Post `
        -ContentType "application/json" `
        -Body $loginBody `
        -WebSession $session | Out-Null

    Write-Host "Login: PASS"

    # 2. Retry the exact original payment request
    Write-Host "`n2. Retrying the existing payment..."

    $paymentBody = @{
        invoiceId = $invoiceId
        amount = "1000.00"
        paymentMethod = "upi"
    } | ConvertTo-Json

    $response = Invoke-RestMethod `
        -Uri "$baseUrl/payments" `
        -Method Post `
        -ContentType "application/json" `
        -Headers @{ "Idempotency-Key" = $idempotencyKey } `
        -Body $paymentBody `
        -WebSession $session

    Write-Host "`nPayment retry response:"
    $response | ConvertTo-Json -Depth 8

    Write-Host "`nIDEMPOTENCY TEST RESPONSE RECEIVED"

}
finally {
    $testPassword = $null
    $securePassword = $null
}
