# Frontend API contract

Base URL: `http://localhost:8000/api/v1`. Every JSON body must be an object. Unknown body fields are rejected; use the generated [OpenAPI](openapi.json) for exact field constraints/defaults. All timestamp output is UTC ISO; interpret attendance date keys in the company timezone. IDs are MongoDB ObjectId strings. Only employee profile and leave-balance `:id` paths accept `me`; use a real employee ID elsewhere.

Success: `{"success":true,"message":"OK","data":...}`. A collection normally returns `data:{items,total,page,limit}`; payroll and payslip collections return arrays with a maximum of 100 runs, and organization returns `{company,units}`. Auth errors use 401, forbidden/ownership/password-change restrictions 403, missing records 404, duplicate/state/stale conflicts 409, business/validation failures 422. `errors` is an array of `{field,reason}`; CSV errors also contain `row` (header is row 1). Errors include a generated request ID; the same ID is returned as `X-Request-Id`. Rate limits return 429 and standard rate-limit headers. AI availability failures return HTTP 200 with `data.fallback:true`.

Send `Authorization: Bearer <JWT>` on all protected calls. No cookie authentication. Send `Content-Type: application/json`. For an action with no parameters send `{}`. Download CSV/PDF as binary/text instead of parsing an envelope. Resource writes return HTTP 200 in this API, including creation.

## Auth and initialization

| Method and path | Who | Input / data |
|---|---|---|
| GET `/setup-status` | Public | data `{initializationRequired:boolean}` only |
| POST `/setup` | Public, first run only | `{companyName,email,password,policy?}` → `{companyName,user}` |
| POST `/auth/login` | Public | `{email,password}` → `{token,tokenType:"Bearer",expiresIn:28800,user}` |
| GET `/auth/me` | All authenticated | public user `{id,email,role,active,mustChangePassword,employeeId?}` |
| POST `/auth/change-password` | All authenticated | `{currentPassword,newPassword}` → `{loginRequired:true}` |
| POST `/auth/logout` | All authenticated | `{}` → `{loggedOut:true}` |

New passwords must contain at least 12 characters and at most 72 UTF-8 bytes (bcrypt's safe input bound). Login always uses generic bad-credentials errors for missing, wrong-password and inactive accounts. Before initialization, public setup is the only way to create the first Admin (or use CLI). After initialization it returns 409 permanently. Neither `/register` nor unrestricted account creation exists. Public health probes are `/health` and `/ready`, outside the version prefix. `/ready` returns 503 when the database is unavailable.

On login, branch on `user.mustChangePassword`. If true, show password change only, with logout available. Call change-password with the temporary password and a new strong password, discard the old token, then log in with the new password. Any invalidated/expired session requires login; there is no refresh endpoint.

## Organization and login administration

| Method and path | Who | Input / data |
|---|---|---|
| GET `/organization` | Admin, HR | `{company:{_id,name,policies,...},units:[...]}` |
| PUT `/organization` | Admin | `{name?,effectiveDate,policy}` complete new policy version |
| POST `/organization/units` | Admin | `{kind:"department"|"designation",name,active?}` |
| PATCH `/organization/units/:id` | Admin | `{name?,active?}` |
| DELETE `/organization/units/:id` | Admin | only unreferenced units; otherwise 409 |
| GET `/users` | Admin | paginated public users |
| POST `/users/hr` | Admin | `{email}` → `{user,temporaryPassword}` |
| POST `/users/:id/reset` | Admin | `{}` → `{user,temporaryPassword}` |
| POST `/users/:id/deactivate` | Admin | `{}` → `{user}`; immediately revokes sessions |
| POST `/users/:id/activate` | Admin | `{}` → `{user}`; previously invalidated sessions stay invalid |
| POST `/users/:id/employee-profile` | Admin | full employee registration body, email must match HR login |

`policies` is an ordered array. For display choose the latest effectiveDate ≤ company-local date; a scheduled future policy must not be displayed as currently effective. The initial policy fields/defaults are:

```json
{
  "timezone":"Asia/Karachi",
  "officeStart":"09:00",
  "officeEnd":"18:00",
  "graceMinutes":15,
  "halfDayHours":5,
  "weekendDays":[6,7],
  "officeLatitude":0,
  "officeLongitude":0,
  "geofenceRadius":150,
  "leaveTypes":[
    {"name":"annual","quota":14,"paid":true,"active":true},
    {"name":"sick","quota":8,"paid":true,"active":true},
    {"name":"casual","quota":10,"paid":true,"active":true},
    {"name":"unpaid","quota":null,"paid":false,"active":true}
  ],
  "holidays":[]
}
```

Holiday shape: `{date:"2026-12-25",name:"Public holiday",active:true}`. Office coordinates are stored for future camera attendance; web check-in does not collect or pretend to verify face/location data. Current policy can be used as the base for a new full version with a future effectiveDate. Units are never fabricated by setup; Admin must create department/designation options.

To enable HR self-service, create their login, then initialize its profile through `/users/:id/employee-profile` using the same email, employee code, job details, dates and salary. This links the existing HR account without a second login or changing its HR role. `employeeId` becomes available after another `/auth/me`; no token refresh is needed because the server loads the user each request.

## Employees and CSV

| Method and path | Who | Input / data |
|---|---|---|
| POST `/employees` | HR | registration body → `{employee,user,temporaryPassword}` |
| GET `/employees` | Admin, HR; Employee own | paginated employee documents |
| GET `/employees/:id` | Admin, HR; Employee own | Employee 360 `{employee,attendance,leaves,payslips}` |
| PATCH `/employees/:id` | HR; Employee own phone/address | allowlisted employee edits |
| PUT `/employees/:id/salary` | HR | `{effectiveDate,basicSalary}` → salaryHistory array |
| POST `/employees/import` | HR | `{csv:string,dryRun:boolean}` |
| GET `/employees/export` | HR | `text/csv`, attachment `employees.csv` |

Registration example (replace IDs with created unit IDs):

```json
{
  "code":"ENG001",
  "email":"person@example.com",
  "name":"Employee Name",
  "departmentId":"0123456789abcdef01234567",
  "designationId":"0123456789abcdef01234568",
  "joiningDate":"2026-10-01",
  "status":"probation",
  "basicSalary":80000,
  "phone":"",
  "address":"",
  "gender":"female",
  "emergencyContact":""
}
```

`exitDate` is optional; required for status `exited`. Gender is required and must be `female|male|other`. Email and code are unique and email is normalized lowercase. Registration creates both account/profile or neither. `salaryHistory:[{effectiveDate,basicMinor}]`, `employmentHistory:[{effectiveDate,status}]` are server-controlled. HR edit fields: name, departmentId, designationId, phone, address, emergencyContact, gender, status, exitDate, effectiveDate. Status/exitDate changes require an increasing future effectiveDate. Code/email/joiningDate cannot be changed. Salary has its own versioned endpoint. Employee PATCH accepts phone/address only; attempted identity/role/salary changes are rejected.

CSV is sent as JSON text, **not** multipart; input limit 1 MB and 1–500 data rows. Header fields match registration keys. Required header values: code,email,name,departmentId,designationId,joiningDate,basicSalary,gender. Optional values should be omitted as columns when unused (empty enum/date fields are invalid). Supply known active department/designation IDs. CSV dates are strict ISO and basicSalary must be positive with ≤2 decimals.

Dry-run returns `{dryRun:true,rowCount,valid,errors:[{row,field,reason}]}` without saving. Import always revalidates inside a transaction and is **all-or-nothing**. Any invalid row returns 422 and nothing is saved. Success returns `{imported,items:[{employee,user,temporaryPassword}]}`; communicate temporary credentials securely at this moment. Duplicates within file or database return row errors. CSV export honors directory filters, exports all matching records rather than only a page, and prefixes formula-like cell values with `'` to prevent spreadsheet formula execution. Export omits salary and credentials.

Collection query parameters (supported subset depends on endpoint): `page` default 1, `limit` default 20 maximum 100, `search` literal escaped substring of name/code/email, `departmentId`, `designationId`, `status`, `sort` in `name|code|joiningDate|-name|-joiningDate`, `from`, `to`, `employeeId`, `state`, `year`. Unknown query keys are rejected. Directory uses search/unit/status/sort/page/limit; status filters and returned directory status use the current effective employment version. Date filters are for attendance/leaves/analytics. Employee scope always forces own identity. Employee 360 includes latest 31 attendance rows, 20 leave requests and 12 published monthly payslips; use dedicated histories for more. Raw Employee 360/edit documents include the latest scheduled `status`; consult employmentHistory for date-effective status.

## Attendance

| Method and path | Who | Input / data |
|---|---|---|
| POST `/attendance/check-in` | Employee, linked HR | `{}` → attendance |
| POST `/attendance/check-out` | Employee, linked HR | `{}` → attendance |
| GET `/attendance` | Admin, HR all; Employee own | page of attendance records, date range defaults to today |
| POST `/attendance/reconcile` | Admin, HR | `{from,to}` → `{changed}`; completed local dates only |
| POST `/attendance/corrections` | Employee, linked HR | `{date,checkIn,checkOut,reason}` → pending request |
| GET `/attendance/corrections` | Admin, HR all; Employee own | page of requests; `state`, `employeeId` filters |
| POST `/attendance/corrections/:id/decision` | HR, other person's request | `{decision:"approved"|"rejected",comment}` |

Attendance document: `{_id,employeeId,date,checkIn?,checkOut?,minutes,late,status,source,policySnapshot,correctionHistory,createdAt,updatedAt}`. `status` is `open|present|late|half_day|missing_checkout|absent|on_leave`. `source` is web or correction. Use separate `late` boolean for late flags including half days. No absence is created for an ongoing day. Run reconciliation to materialize absent/on-leave rows and missing checkouts for past days; the dashboard derives historical gaps without needing that write. Today’s board rows are currently checked-in sessions; approved leave is available via `/leaves?state=approved&from=...&to=...` and dashboard KPIs.

Correction timestamps must include UTC offset and both fall on the requested local date. Example `{"date":"2026-10-23","checkIn":"2026-10-23T09:00:00+05:00","checkOut":"2026-10-23T17:00:00+05:00","reason":"Connection failure"}`. HR must comment on every decision. No direct attendance PATCH/DELETE exists.

## Leave

| Method and path | Who | Input / data |
|---|---|---|
| POST `/leaves` | Employee, linked HR | `{type,start,end,reason}` → request with allocated days |
| GET `/leaves` | Admin, HR all; Employee own | page; filters state/from/to/employeeId/departmentId |
| GET `/leaves/balances/:id?year=2026` | Admin, HR; Employee own | `{employeeId,year,pendingReservesBalance:false,types}` |
| POST `/leaves/:id/cancel` | Request owner Employee/HR | `{}`; only future pending/approved |
| POST `/leaves/:id/decision` | HR, other person's request | `{decision:"approved"|"rejected",comment}` |

Request: `{_id,employeeId,type,start,end,reason,days:[{date,year,paid,quota}],state,comment?,reviewedBy?,...timestamps}`. Balance type: `{type,quota,used,remaining,active}`; unlimited quota and remaining are null. Pending does not reserve. Overlap or insufficient quota returns 422 on application/approval. Year-crossing days use independent annual allocations. Cancellation restores approved use; started requests cannot be cancelled. An Employee cannot cancel a colleague's request, and HR cannot approve their own.

## Salary, payroll and payslips

| Method and path | Who | Input / data |
|---|---|---|
| PUT `/employees/:id/salary` | HR | positive `{basicSalary,effectiveDate}` |
| POST `/payroll` | HR | `{month:"2026-10"}` create/recalculate draft |
| GET `/payroll` | Admin, HR | latest 100 runs, breakdown omitted |
| GET `/payroll/:id` | Admin, HR | full saved draft/finalized run |
| POST `/payroll/:id/finalize` | Admin | `{}` after month-end; stale draft returns 409 |
| GET `/payslips` | Admin, HR all; Employee own published | array of slips with runId/month/state |
| GET `/payslips/:runId/:employeeId` | Admin, HR; Employee own published | saved slip JSON |
| GET `/payslips/:runId/:employeeId/pdf` | Same | downloadable `application/pdf` |

Run: `{_id,month,state,sourceRevision,generatedAt,finalizedAt?,finalizedBy?,policySnapshots,slips}`. Slip: `{employeeId,employeeCode,employeeName,departmentId,designationId,companyName,currency:"PKR",basicMinor,hraMinor,medicalMinor,grossMinor,workingDays,eligibleDays,absentDays,unpaidDays,halfDays,deductionsMinor,taxMinor,netMinor,breakdown:[{date,basicMinor,grossMonthlyMinor,perDayMinor,deductionFactor,reason,attendanceId?,leavePaid?,policyEffectiveDate}]}`. `basicMinor` on the slip is the prorated month total; on daily breakdown it is that day's applicable full monthly basic. `reason`: payable, paid_leave, unpaid_leave, absent or half_day.

Drafts are visible to HR/Admin only; ongoing month drafts project future working dates as payable. Generate the final draft after month end, then Admin finalizes without intervening business writes. Finalization publishes all saved slips and creates notifications. Repeated finalization or draft generation for a locked month returns 409. All money is integer paisa; display as `(value / 100).toFixed(2)`. See RULES.md for tax, proration, rounding and missing-checkout treatment.

## Dashboards and read tools

`GET /dashboard?from=2026-10-01&to=2026-10-24&departmentId=...` returns the authenticated role's scope. Date filters cannot include future dates. Empty datasets return zeros/empty arrays, never sample values.

Response keys: `from,to,headcount,exits,attritionPercent,attendance,attendanceRate,latePercent,absenteeismPercent,pendingApprovals,trend,byDepartment,lateComers,leaveByType,leaveUtilizationPercent,leaveUtilizationByType,payroll,averageGrossMinor,salaryByDesignation,gender,tenure,announcements`. Admin also receives `auditFeed`. Employee also receives `leaveBalance,hoursWorked,weeklyTargetHours,lastPayslip`. `attendance` contains exclusive status counts plus expectedDays,lateFlags,minutes. Payroll contains grossMinor/netMinor and byMonth/byDepartment maps. By-department rows also contain averageGrossMinor, leaveByType and leaveUtilizationByType. Each type-utilization row is `{type,used,quota,percent}`; unlimited/zero-denominator percentage is null. Attendance/attrition/late percentages use 0–100; utilization can exceed 100% across a multiple-year range because its denominator is an annual quota. Tenure groups are under1Year,oneToThreeYears,over3Years.

Seven `GET /analytics/<tool-name>` endpoints expose the same business services used by AI. Tool names: `get_headcount`, `get_attendance_summary`, `get_late_comers`, `get_leave_summary`, `get_my_leave_balance`, `get_payroll_summary`, `search_employees`. Company headcount, late-comers, payroll summary and employee search require Admin/HR. Attendance/leave summaries remain own-only for Employee. `get_my_leave_balance` requires a linked profile, and accepts `year`. The rest accept applicable `from,to,departmentId,search` parameters. AI cannot bypass these checks. Leave summary defaults to today and returns `{from,to,byType:[{type,days}],requests:[{id,employeeId,name,type,start,end,days}],requestsTruncated}`. Its counts are complete; request details are capped at 100. Attendance/headcount/payroll tools otherwise default to the dashboard month-to-date range.

## Communications and audit

| Method and path | Who | Input / data |
|---|---|---|
| GET `/announcements` | All | page of `{_id,title,body,authorId,...timestamps}` |
| POST `/announcements` | Admin, HR | `{title,body}` |
| GET `/notifications` | All, own | page of `{_id,userId,title,entityId,readAt?,...timestamps}` |
| POST `/notifications/:id/read` | Owner | `{}`; idempotent mark read |
| GET `/audit-logs` | Admin | page, optional from/to; `{actorId,action,entity,entityId,before,after,...timestamps}` |

Do not render announcement/model/user text as raw HTML. Audit is immutable through the API. Notifications are created transactionally on correction decisions, leave decisions and payroll publication. Their entityId points to the relevant correction/leave/payroll ID.

## AI

| Method and path | Who | Input / data |
|---|---|---|
| POST `/ai/chat` | All | `{message}` → `{label:"AI-generated",answer,toolsUsed}` |
| POST `/ai/summary` | Admin, HR | `{filters?:{from,to,departmentId}}` → `{label,bullets:[3–5 strings]}` |
| POST `/ai/smart-leave` | Employee, HR | `{message}` → `{label,proposal:{type,start,end,reason},requiresConfirmation:true}` |

When `fallback:true`, display the provided safe `message` and ordinary form/dashboard. Smart leave never saves anything: show the validated proposal for user review, then send **only** its four leave fields to the ordinary `/leaves` endpoint after confirmation. No provider key or provider URL is needed by the frontend. Answers always carry an AI-generated label. The AI is read-only and has no mutation tool. All features combined are limited to 20 calls per authenticated user/hour, with a 15-second provider timeout. A colleague salary request from an Employee is refused by the assistant prompt and cannot be fulfilled by its tools.

## Suggested judging flow

Setup → Admin login → create department/designation → create HR → HR login/password change/login → register employees → Employee login/password change/login → check in/out → request future leave → HR approves → inspect dashboard and AI summary → HR generates a **closed month** draft for historical employees → Admin finalizes → Employee downloads PDF → inspect Admin audit. For current-month live activity, review the draft and demonstrate month-close protection; finalization intentionally rejects an ongoing month.
