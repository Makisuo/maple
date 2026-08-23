/**
 * Customer tax-ID types Stripe accepts on `POST /v1/customers/{id}/tax_ids`.
 *
 * The one list behind both the domain schema (`BillingTaxIdType`) and the
 * billing-details picker in the web app. Mirrors Stripe's "Supported tax ID
 * types" table: `country` is the ISO-3166 alpha-2 code the type belongs to
 * (EU members all share `eu_vat`; `eu_oss_vat` is the non-Union OSS scheme),
 * `example` is Stripe's own formatting example, shown as the input placeholder.
 *
 * Stripe validates the FORMAT synchronously and verifies EU VAT (VIES), GB VAT
 * (HMRC) and AU ABN asynchronously — `verification.status` moves from
 * `pending` to `verified` / `unverified` / `unavailable` after the fact.
 */
export interface TaxIdTypeInfo {
	readonly type: string
	readonly country: string
	readonly label: string
	readonly example: string
}

const EU_VAT_COUNTRIES: ReadonlyArray<readonly [country: string, example: string]> = [
	["AT", "ATU12345678"],
	["BE", "BE0123456789"],
	["BG", "BG0123456789"],
	["CY", "CY12345678Z"],
	["CZ", "CZ1234567890"],
	["DE", "DE123456789"],
	["DK", "DK12345678"],
	["EE", "EE123456789"],
	["ES", "ESA1234567Z"],
	["FI", "FI12345678"],
	["FR", "FRAB123456789"],
	["GR", "EL123456789"],
	["HR", "HR12345678912"],
	["HU", "HU12345678"],
	["IE", "IE1234567AB"],
	["IT", "IT12345678912"],
	["LT", "LT123456789123"],
	["LU", "LU12345678"],
	["LV", "LV12345678912"],
	["MT", "MT12345678"],
	["NL", "NL123456789B12"],
	["PL", "PL1234567890"],
	["PT", "PT123456789"],
	["RO", "RO1234567891"],
	["SE", "SE123456789123"],
	["SI", "SI12345678"],
	["SK", "SK1234567891"],
]

/** Countries whose business VAT number is the shared `eu_vat` type. */
const EU_VAT_COUNTRY_CODES: ReadonlyArray<string> = EU_VAT_COUNTRIES.map(([country]) => country)

/**
 * Every type Stripe accepts, as a tuple so `Schema.Literals` keeps the literal
 * union. `eu_vat` is listed once here; the per-country examples live in
 * `EU_VAT_COUNTRIES` and are resolved by `taxIdExampleFor`.
 */
export const TAX_ID_TYPE_VALUES = [
	"ad_nrt",
	"ae_trn",
	"al_tin",
	"am_tin",
	"ao_tin",
	"ar_cuit",
	"au_abn",
	"au_arn",
	"aw_tin",
	"az_tin",
	"ba_tin",
	"bb_tin",
	"bd_bin",
	"bf_ifu",
	"bg_uic",
	"bh_vat",
	"bj_ifu",
	"bo_tin",
	"br_cnpj",
	"br_cpf",
	"bs_tin",
	"by_tin",
	"ca_bn",
	"ca_gst_hst",
	"ca_pst_bc",
	"ca_pst_mb",
	"ca_pst_sk",
	"ca_qst",
	"cd_nif",
	"ch_uid",
	"ch_vat",
	"cl_tin",
	"cm_niu",
	"cn_tin",
	"co_nit",
	"cr_tin",
	"cv_nif",
	"de_stn",
	"do_rcn",
	"ec_ruc",
	"eg_tin",
	"es_cif",
	"et_tin",
	"eu_oss_vat",
	"eu_vat",
	"fo_vat",
	"gb_vat",
	"ge_vat",
	"gi_tin",
	"gn_nif",
	"hk_br",
	"hr_oib",
	"hu_tin",
	"ic_nif",
	"id_npwp",
	"il_vat",
	"in_gst",
	"is_vat",
	"it_cf",
	"jp_cn",
	"jp_rn",
	"jp_trn",
	"ke_pin",
	"kg_tin",
	"kh_tin",
	"kr_brn",
	"kz_bin",
	"la_tin",
	"li_uid",
	"li_vat",
	"lk_vat",
	"ma_vat",
	"md_vat",
	"me_pib",
	"mk_vat",
	"mr_nif",
	"mx_rfc",
	"my_frp",
	"my_itn",
	"my_sst",
	"ng_tin",
	"no_vat",
	"no_voec",
	"np_pan",
	"nz_gst",
	"om_vat",
	"pe_ruc",
	"ph_tin",
	"pl_nip",
	"py_ruc",
	"ro_tin",
	"rs_pib",
	"ru_inn",
	"ru_kpp",
	"sa_vat",
	"sg_gst",
	"sg_uen",
	"si_tin",
	"sn_ninea",
	"sr_fin",
	"sv_nit",
	"th_vat",
	"tj_tin",
	"tr_tin",
	"tw_vat",
	"tz_vat",
	"ua_vat",
	"ug_tin",
	"us_ein",
	"uy_ruc",
	"uz_tin",
	"uz_vat",
	"ve_rif",
	"vn_tin",
	"za_vat",
	"zm_tin",
	"zw_tin",
] as const

export type TaxIdType = (typeof TAX_ID_TYPE_VALUES)[number]

/** Human label + home country + Stripe's example for every supported type. */
export const TAX_ID_TYPES: ReadonlyArray<TaxIdTypeInfo> = [
	{ type: "eu_vat", country: "EU", label: "EU VAT number", example: "DE123456789" },
	{ type: "gb_vat", country: "GB", label: "United Kingdom VAT number", example: "GB123456789" },
	{ type: "ch_vat", country: "CH", label: "Switzerland VAT number", example: "CHE-123.456.789 MWST" },
	{ type: "ch_uid", country: "CH", label: "Switzerland UID number", example: "CHE-123.456.789 HR" },
	{ type: "no_vat", country: "NO", label: "Norwegian VAT number", example: "123456789MVA" },
	{ type: "no_voec", country: "NO", label: "Norwegian VAT on e-commerce number", example: "1234567" },
	{ type: "us_ein", country: "US", label: "United States EIN", example: "12-3456789" },
	{ type: "ca_bn", country: "CA", label: "Canadian BN", example: "123456789" },
	{ type: "ca_gst_hst", country: "CA", label: "Canadian GST/HST number", example: "123456789RT0002" },
	{
		type: "ca_pst_bc",
		country: "CA",
		label: "Canadian PST number (British Columbia)",
		example: "PST-1234-5678",
	},
	{ type: "ca_pst_mb", country: "CA", label: "Canadian PST number (Manitoba)", example: "123456-7" },
	{ type: "ca_pst_sk", country: "CA", label: "Canadian PST number (Saskatchewan)", example: "1234567" },
	{ type: "ca_qst", country: "CA", label: "Canadian QST number (Québec)", example: "1234567890TQ1234" },
	{ type: "au_abn", country: "AU", label: "Australian Business Number (ABN)", example: "12345678912" },
	{
		type: "au_arn",
		country: "AU",
		label: "Australian Taxation Office Reference Number",
		example: "123456789123",
	},
	{ type: "nz_gst", country: "NZ", label: "New Zealand GST number", example: "123456789" },
	{ type: "in_gst", country: "IN", label: "Indian GST number", example: "12ABCDE3456FGZH" },
	{ type: "sg_gst", country: "SG", label: "Singaporean GST", example: "M12345678X" },
	{ type: "sg_uen", country: "SG", label: "Singaporean UEN", example: "123456789F" },
	{ type: "jp_cn", country: "JP", label: "Japanese Corporate Number", example: "1234567891234" },
	{ type: "jp_rn", country: "JP", label: "Japanese Registered Foreign Business Number", example: "12345" },
	{ type: "jp_trn", country: "JP", label: "Japanese Tax Registration Number", example: "T1234567891234" },
	{ type: "kr_brn", country: "KR", label: "Korean BRN", example: "123-45-67890" },
	{ type: "tw_vat", country: "TW", label: "Taiwanese VAT", example: "12345678" },
	{ type: "hk_br", country: "HK", label: "Hong Kong BR number", example: "12345678" },
	{ type: "cn_tin", country: "CN", label: "Chinese tax ID", example: "123456789012345678" },
	{ type: "il_vat", country: "IL", label: "Israel VAT", example: "000012345" },
	{ type: "ae_trn", country: "AE", label: "United Arab Emirates TRN", example: "123456789012345" },
	{ type: "sa_vat", country: "SA", label: "Saudi Arabia VAT", example: "123456789012345" },
	{ type: "za_vat", country: "ZA", label: "South African VAT number", example: "4123456789" },
	{ type: "br_cnpj", country: "BR", label: "Brazilian CNPJ number", example: "01.234.456/5432-10" },
	{ type: "br_cpf", country: "BR", label: "Brazilian CPF number", example: "123.456.789-87" },
	{ type: "mx_rfc", country: "MX", label: "Mexican RFC number", example: "ABC010203AB9" },
	{ type: "ar_cuit", country: "AR", label: "Argentinian tax ID number", example: "12-3456789-01" },
	{ type: "cl_tin", country: "CL", label: "Chilean TIN", example: "12.345.678-K" },
	{ type: "co_nit", country: "CO", label: "Colombian NIT number", example: "123.456.789-0" },
	{ type: "pe_ruc", country: "PE", label: "Peruvian RUC number", example: "12345678901" },
	{ type: "uy_ruc", country: "UY", label: "Uruguayan RUC number", example: "123456789012" },
	{
		type: "eu_oss_vat",
		country: "EU",
		label: "EU One Stop Shop VAT number (non-Union)",
		example: "EU123456789",
	},
	{ type: "de_stn", country: "DE", label: "German Tax Number (Steuernummer)", example: "1234567890" },
	{ type: "es_cif", country: "ES", label: "Spanish NIF number", example: "A12345678" },
	{ type: "it_cf", country: "IT", label: "Italian Codice Fiscale", example: "ABCDEF12A12A123A" },
	{ type: "pl_nip", country: "PL", label: "Polish NIP number", example: "1234567890" },
	{ type: "bg_uic", country: "BG", label: "Bulgaria Unified Identification Code", example: "123456789" },
	{
		type: "hr_oib",
		country: "HR",
		label: "Croatian Personal Identification Number",
		example: "12345678901",
	},
	{ type: "hu_tin", country: "HU", label: "Hungary tax number (adószám)", example: "12345678-1-23" },
	{ type: "ro_tin", country: "RO", label: "Romanian tax ID number", example: "1234567890123" },
	{ type: "si_tin", country: "SI", label: "Slovenia tax number (davčna številka)", example: "12345678" },
	{ type: "ic_nif", country: "IC", label: "Canary Islands NIF number", example: "A12345678" },
	{ type: "li_uid", country: "LI", label: "Liechtensteinian UID number", example: "CHE123456789" },
	{ type: "li_vat", country: "LI", label: "Liechtensteinian VAT number", example: "12345" },
	{ type: "is_vat", country: "IS", label: "Icelandic VAT", example: "123456" },
	{ type: "fo_vat", country: "FO", label: "Faroe Islands VAT number", example: "FO123456" },
	{ type: "ad_nrt", country: "AD", label: "Andorran NRT number", example: "A-123456-Z" },
	{ type: "gi_tin", country: "GI", label: "Gibraltar Tax Identification Number", example: "12345" },
	{ type: "al_tin", country: "AL", label: "Albania Tax Identification Number", example: "J12345678N" },
	{
		type: "ba_tin",
		country: "BA",
		label: "Bosnia and Herzegovina Tax Identification Number",
		example: "123456789012",
	},
	{ type: "me_pib", country: "ME", label: "Montenegro PIB Number", example: "12345678" },
	{ type: "mk_vat", country: "MK", label: "North Macedonia VAT Number", example: "MK1234567890123" },
	{ type: "rs_pib", country: "RS", label: "Serbian PIB number", example: "123456789" },
	{ type: "md_vat", country: "MD", label: "Moldova VAT Number", example: "1234567" },
	{ type: "ua_vat", country: "UA", label: "Ukrainian VAT", example: "123456789" },
	{ type: "by_tin", country: "BY", label: "Belarus TIN Number", example: "123456789" },
	{ type: "ru_inn", country: "RU", label: "Russian INN", example: "1234567891" },
	{ type: "ru_kpp", country: "RU", label: "Russian KPP", example: "123456789" },
	{ type: "ge_vat", country: "GE", label: "Georgian VAT", example: "123456789" },
	{ type: "am_tin", country: "AM", label: "Armenia Tax Identification Number", example: "02538904" },
	{ type: "az_tin", country: "AZ", label: "Azerbaijan Tax Identification Number", example: "0123456789" },
	{
		type: "kz_bin",
		country: "KZ",
		label: "Kazakhstani Business Identification Number",
		example: "123456789012",
	},
	{
		type: "kg_tin",
		country: "KG",
		label: "Kyrgyzstan Tax Identification Number",
		example: "12345678901234",
	},
	{ type: "tj_tin", country: "TJ", label: "Tajikistan Tax Identification Number", example: "123456789" },
	{ type: "uz_tin", country: "UZ", label: "Uzbekistan TIN Number", example: "123456789" },
	{ type: "uz_vat", country: "UZ", label: "Uzbekistan VAT Number", example: "123456789012" },
	{ type: "tr_tin", country: "TR", label: "Turkish Tax Identification Number", example: "0123456789" },
	{ type: "bh_vat", country: "BH", label: "Bahraini VAT Number", example: "123456789012345" },
	{ type: "om_vat", country: "OM", label: "Omani VAT Number", example: "OM1234567890" },
	{ type: "eg_tin", country: "EG", label: "Egyptian Tax Identification Number", example: "123456789" },
	{ type: "ma_vat", country: "MA", label: "Morocco VAT Number", example: "12345678" },
	{ type: "ng_tin", country: "NG", label: "Nigerian Tax Identification Number", example: "1234567890123" },
	{ type: "ke_pin", country: "KE", label: "Kenya Revenue Authority PIN", example: "P000111111A" },
	{ type: "tz_vat", country: "TZ", label: "Tanzania VAT Number", example: "12345678A" },
	{ type: "ug_tin", country: "UG", label: "Uganda Tax Identification Number", example: "1014751879" },
	{ type: "et_tin", country: "ET", label: "Ethiopia Tax Identification Number", example: "1234567890" },
	{ type: "zm_tin", country: "ZM", label: "Zambia Tax Identification Number", example: "1004751879" },
	{ type: "zw_tin", country: "ZW", label: "Zimbabwe Tax Identification Number", example: "1234567890" },
	{ type: "ao_tin", country: "AO", label: "Angola Tax Identification Number", example: "5123456789" },
	{
		type: "bf_ifu",
		country: "BF",
		label: "Burkina Faso Tax Identification Number (IFU)",
		example: "12345678A",
	},
	{
		type: "bj_ifu",
		country: "BJ",
		label: "Benin Tax Identification Number (IFU)",
		example: "1234567890123",
	},
	{
		type: "cd_nif",
		country: "CD",
		label: "Congo (DR) Tax Identification Number (NIF)",
		example: "A0123456M",
	},
	{
		type: "cm_niu",
		country: "CM",
		label: "Cameroon Tax Identification Number (NIU)",
		example: "M123456789000L",
	},
	{
		type: "cv_nif",
		country: "CV",
		label: "Cape Verde Tax Identification Number (NIF)",
		example: "213456789",
	},
	{ type: "gn_nif", country: "GN", label: "Guinea Tax Identification Number (NIF)", example: "123456789" },
	{
		type: "mr_nif",
		country: "MR",
		label: "Mauritania Tax Identification Number (NIF)",
		example: "12345678",
	},
	{ type: "sn_ninea", country: "SN", label: "Senegal NINEA Number", example: "12345672A2" },
	{
		type: "bd_bin",
		country: "BD",
		label: "Bangladesh Business Identification Number",
		example: "123456789-0123",
	},
	{ type: "np_pan", country: "NP", label: "Nepal PAN Number", example: "123456789" },
	{ type: "lk_vat", country: "LK", label: "Sri Lanka VAT number", example: "123456789-1234" },
	{ type: "th_vat", country: "TH", label: "Thai VAT", example: "1234567891234" },
	{ type: "vn_tin", country: "VN", label: "Vietnamese tax ID number", example: "1234567890" },
	{ type: "kh_tin", country: "KH", label: "Cambodia Tax Identification Number", example: "1001-123456789" },
	{ type: "la_tin", country: "LA", label: "Laos Tax Identification Number", example: "123456789-000" },
	{ type: "my_frp", country: "MY", label: "Malaysian FRP number", example: "12345678" },
	{ type: "my_itn", country: "MY", label: "Malaysian ITN", example: "C 1234567890" },
	{ type: "my_sst", country: "MY", label: "Malaysian SST number", example: "A12-3456-78912345" },
	{ type: "id_npwp", country: "ID", label: "Indonesian NPWP number", example: "012.345.678.9-012.345" },
	{
		type: "ph_tin",
		country: "PH",
		label: "Philippines Tax Identification Number",
		example: "123456789012",
	},
	{ type: "aw_tin", country: "AW", label: "Aruba Tax Identification Number", example: "12345678" },
	{ type: "bb_tin", country: "BB", label: "Barbados Tax Identification Number", example: "1123456789012" },
	{ type: "bs_tin", country: "BS", label: "Bahamas Tax Identification Number", example: "123.456.789" },
	{ type: "bo_tin", country: "BO", label: "Bolivian tax ID", example: "123456789" },
	{ type: "cr_tin", country: "CR", label: "Costa Rican tax ID", example: "1-234-567890" },
	{ type: "do_rcn", country: "DO", label: "Dominican RCN number", example: "123-4567890-1" },
	{ type: "ec_ruc", country: "EC", label: "Ecuadorian RUC number", example: "1234567890001" },
	{ type: "py_ruc", country: "PY", label: "Paraguayan RUC number", example: "12345678A" },
	{ type: "sr_fin", country: "SR", label: "Suriname FIN Number", example: "1234567890" },
	{ type: "sv_nit", country: "SV", label: "El Salvadorian NIT number", example: "1234-567890-123-4" },
	{ type: "ve_rif", country: "VE", label: "Venezuelan RIF number", example: "A-12345678-9" },
]

const TAX_ID_TYPE_BY_VALUE: ReadonlyMap<string, TaxIdTypeInfo> = new Map(
	TAX_ID_TYPES.map((info) => [info.type, info]),
)

export const isTaxIdType = (value: string): value is TaxIdType => TAX_ID_TYPE_BY_VALUE.has(value)

/** Short display label for a type, falling back to the raw enum for an unknown upstream value. */
export const taxIdLabel = (type: string): string => TAX_ID_TYPE_BY_VALUE.get(type)?.label ?? type

/**
 * The type a business in `country` most likely wants preselected: the shared
 * `eu_vat` for EU members, otherwise the country's first listed type (the list
 * is ordered VAT/GST-first per country), or `undefined` when Stripe has none.
 */
export const defaultTaxIdTypeFor = (country: string | null | undefined): TaxIdType | undefined => {
	if (!country) return undefined
	const code = country.toUpperCase()
	if (EU_VAT_COUNTRY_CODES.includes(code)) return "eu_vat"
	const match = TAX_ID_TYPES.find((info) => info.country === code)
	return match === undefined || !isTaxIdType(match.type) ? undefined : match.type
}

/** Stripe's formatting example for a type, country-specific for `eu_vat`. */
export const taxIdExampleFor = (type: string, country?: string | null): string => {
	if (type === "eu_vat" && country) {
		const eu = EU_VAT_COUNTRIES.find(([code]) => code === country.toUpperCase())
		if (eu) return eu[1]
	}
	return TAX_ID_TYPE_BY_VALUE.get(type)?.example ?? ""
}
