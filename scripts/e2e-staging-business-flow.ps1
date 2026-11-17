
$ErrorActionPreference = "Stop"

$baseUrl = "http://localhost:5001/api/v1"
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$securePassword = Read-Host "Staging test account password" -AsSecureString

try {
    $testPassword = [System.Net.NetworkCredential]::new(
        "",
        $securePassword
    ).Password

    $runId = Get-Date -Format "yyyyMMddHHmmss"

    # 1. Login with the existing staging owner
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

    # 2. Create synthetic student
    Write-Host "`n2. Creating student..."

    $studentBody = @{
        name = "E2E Student $runId"
        admissionNumber = "E2E-$runId"
        parentName = "Synthetic Test Parent"
        parentWhatsapp = "+12025550100"
    } | ConvertTo-Json

    $studentResponse = Invoke-RestMethod `
        -Uri "$baseUrl/students" `
        -Method Post `
        -ContentType "application/json" `
        -Body $studentBody `
        -WebSession $session

    $studentId = $studentResponse.data.id

    if (-not $studentId) {
        throw "Student ID missing from response"
    }

    Write-Host "Student: PASS | ID: $studentId"

    # 3. Grant synthetic receipt consent
    Write-Host "`n3. Recording receipt consent..."

    $consentBody = @{
        studentId = $studentId
        purpose = "receipt"
        action = "granted"
        source = "e2e_test"
        evidenceReference = "synthetic-staging-test-$runId"
    } | ConvertTo-Json

    $consentResponse = Invoke-RestMethod `
        -Uri "$baseUrl/consents" `
        -Method Post `
        -ContentType "application/json" `
        -Body $consentBody `
        -WebSession $session

    Write-Host "Consent: PASS"
    $consentResponse | ConvertTo-Json -Depth 5

    # 4. Create synthetic invoice
    Write-Host "`n4. Creating invoice..."

    $invoiceBody = @{
        studentId = $studentId
        description = "E2E Tuition Fee $runId"
        amountDue = "1000.00"
        dueDate = "2026-11-30"
    } | ConvertTo-Json

    $invoiceResponse = Invoke-RestMethod `
        -Uri "$baseUrl/invoices" `
        -Method Post `
        -ContentType "application/json" `
        -Body $invoiceBody `
        -WebSession $session

    $invoiceId = $invoiceResponse.data.invoice.id

    if (-not $invoiceId) {
        throw "Invoice ID missing from response"
    }

    Write-Host "Invoice: PASS | ID: $invoiceId"

    # 5. Record synthetic staging payment
    Write-Host "`n5. Recording synthetic payment..."

    $paymentBody = @{
        invoiceId = $invoiceId
        amount = "1000.00"
        paymentMethod = "upi"
    } | ConvertTo-Json

    $paymentResponse = Invoke-RestMethod `
        -Uri "$baseUrl/payments" `
        -Method Post `
        -ContentType "application/json" `
        -Headers @{ "Idempotency-Key" = "e2e-payment-$runId" } `
        -Body $paymentBody `
        -WebSession $session

    Write-Host "Payment response:"
    $paymentResponse | ConvertTo-Json -Depth 6

    Write-Host "`nBUSINESS FLOW COMPLETED"
    Write-Host "Student ID: $studentId"
    Write-Host "Invoice ID: $invoiceId"
    Write-Host "Run ID: $runId"
}
finally {
    $testPassword = $null
    $loginBody = $null

    if ($securePassword) {
        $securePassword.Dispose()
        $securePassword = $null
    }
}
