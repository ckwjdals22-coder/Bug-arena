"""남는자리 단위경제 추정 모델 (docs/01-market-research.md 10.1절의 계산 근거).

실행: python3 docs/research/unit-economics.py

입력값은 실측이 아니라 가정이다. 공석률·마켓 충원율·경로 비율·보상 크레딧 비율은
파일럿 원장 데이터가 쌓이면 실측값으로 바꿔 다시 돌린다.
금액은 원, 수수료 매출은 VAT 제외 공급가(요율은 VAT 포함으로 가정)로 계산한다.
"""

WEEKS_PER_MONTH = 4.33

# (이름, 사업자 수, 주당 회차, 회차당 좌석, 충원 좌석 평균가, 공석률, 마켓 충원율, (신규, 재방문, 자체 링크) 비율)
SCENARIOS = [
    ("보수", 3, 6, 14, 30_000, 0.08, 0.15, (0.50, 0.20, 0.30)),
    ("기준", 6, 12, 16, 35_000, 0.15, 0.30, (0.60, 0.20, 0.20)),
    ("낙관", 12, 24, 18, 40_000, 0.22, 0.45, (0.65, 0.20, 0.15)),
]

# 월 고정비(VAT 별도, 인건비·마케팅·법률 자문 제외)
FIXED_MIN = 110_000 / 12 + 220_000 / 12 + 63_000 + 10_000  # PG 연관리비 + 가입비 12개월 상각 + 호스팅 + 도메인
FIXED_STD = FIXED_MIN + 300_000 + 50_000 + 110_000 / 12 + 100_000  # + 지급대행 + 다날 A형 + 등록비 상각 + 세무기장(추정)


def scenario(name, sellers, sessions_wk, seats, price, vacancy, fill, mix, *,
             pg=0.034, credit=0.01, new_rate=0.099, ret_rate=0.049,
             min_fee=0, cap=10_000, msgs=5, msg_cost=13, idv=30,
             pg_passthrough_returning=False):
    """한 시나리오의 월 공헌이익을 계산한다.

    pg_passthrough_returning=True 이면 재방문 건의 결제 실비를 사업자가 부담한다
    (재방문 중개 0% + 결제 실비 안). 자체 링크 건의 결제 실비는 항상 사업자 부담이다.
    """
    seats_mo = sessions_wk * seats * WEEKS_PER_MONTH
    vacant = seats_mo * vacancy
    fills = vacant * fill
    gmv = fills * price
    new, ret, _own = mix

    def fee(rate, floor=0):
        f = price * rate
        if floor:
            f = max(f, min(floor, price * 0.2))
        return min(f, cap) / 1.1  # VAT 제외

    revenue = fills * (new * fee(new_rate, min_fee) + ret * fee(ret_rate))
    pg_share = new + (0 if pg_passthrough_returning else ret)
    pg_cost = fills * pg_share * price * pg
    msg = fills * msgs * msg_cost
    idv_cost = fills * new * idv
    credits = gmv * credit
    contrib = revenue - pg_cost - msg - idv_cost - credits
    return {
        "name": name, "sellers": sellers, "seats_mo": seats_mo, "vacant": vacant,
        "fills": fills, "gmv": gmv, "revenue": revenue, "pg": pg_cost,
        "other": msg + idv_cost + credits, "contrib": contrib,
        "per_fill": contrib / fills if fills else 0,
    }


def row(r):
    return (f"{r['name']}: 좌석 {r['seats_mo']:.0f} / 공석 {r['vacant']:.0f} / 충원 {r['fills']:.1f}건 / "
            f"GMV {r['gmv']:,.0f} / 매출 {r['revenue']:,.0f} / PG {r['pg']:,.0f} / 기타 {r['other']:,.0f} / "
            f"공헌이익 {r['contrib']:,.0f} (건당 {r['per_fill']:,.0f})")


VARIANTS = [
    ("A. 기존 제안: 신규 9.9% / 재방문 4.9% (PG 3.4%)", {}),
    ("B. A + 신규 건당 최소 3,000원(좌석가 20% 이내, 재방문에는 미적용)", {"min_fee": 3000}),
    ("C. A + PG 영세 우대 1.65%", {"pg": 0.0165}),
    ("D. 신규 15% / 재방문 9.9% (참고용 고율안)", {"new_rate": 0.15, "ret_rate": 0.099}),
    ("E. 권고안: 신규 9.9% + 최소 3,000원 / 재방문 중개 0% + 결제 실비 사업자 부담",
     {"min_fee": 3000, "ret_rate": 0.0, "pg_passthrough_returning": True}),
    ("F. E에서 최소 수수료만 뺀 경우", {"ret_rate": 0.0, "pg_passthrough_returning": True}),
]

if __name__ == "__main__":
    print(f"월 고정비: 최소 {FIXED_MIN:,.0f} / 표준 {FIXED_STD:,.0f}")
    for title, kw in VARIANTS:
        print(f"\n--- {title}")
        for s in SCENARIOS:
            r = scenario(*s, **kw)
            print(row(r), f"| 월 손익 최소 {r['contrib'] - FIXED_MIN:,.0f} / 표준 {r['contrib'] - FIXED_STD:,.0f}")

    print("\n--- 손익분기 충원 건수(좌석 35,000원, 전부 신규, 9.9% 정률)")
    p = 35_000
    per_fill = p * 0.099 / 1.1 - p * 0.034 - 5 * 13 - 30 - p * 0.01
    print(f"건당 {per_fill:,.0f} → 최소 고정비 {FIXED_MIN / per_fill:,.0f}건 / 표준 {FIXED_STD / per_fill:,.0f}건 / "
          f"표준+인건비 300만 {(FIXED_STD + 3_000_000) / per_fill:,.0f}건")

    print("\n--- 최소 수수료 3,000원(좌석가 20% 이내)이 실제로 작동하는 좌석가")
    print(f"9.9%가 3,000원에 못 미치는 좌석가: {3000 / 0.099:,.0f}원 미만")
    for price in (10_000, 15_000, 24_000, 29_000, 35_000, 50_000, 70_000):
        base = price * 0.099
        charged = min(max(base, min(3000, price * 0.2)), 10_000)
        print(f"  {price:,}원: 9.9% = {base:,.0f} → 부과 {charged:,.0f} (실효 {charged / price:.1%}, +{charged - base:,.0f})")

    print("\n--- 지급대행 고정비(월 30만원)를 메우는 마켓 신규 GMV")
    net_take = 0.099 / 1.1 - 0.034
    print(f"순수취 {net_take:.3%} → GMV {300_000 / net_take:,.0f} ({300_000 / net_take / 35_000:,.0f}건 × 35,000원)")

    print("\n--- Pro 구독 매출(19,900원 VAT 포함)")
    for n in (6, 12, 30, 50, 100):
        print(f"{n}곳: {n * 19_900 / 1.1:,.0f}")

    print("\n--- 런칭 프로모션 비용(기존 제안 A 기준)")
    for label, bookings, months in (("첫 30건 또는 6개월", 30, 6), ("첫 10건 또는 3개월", 10, 3)):
        print(label)
        for s in SCENARIOS:
            r = scenario(*s)
            per_seller = r["fills"] / r["sellers"]
            free_months = min(months, bookings / per_seller)
            print(f"  {r['name']}: 사업자당 월 {per_seller:.1f}건 → 무료 {free_months:.1f}개월, "
                  f"포기 순수취 {(r['revenue'] - r['pg']) * free_months:,.0f}, "
                  f"결제 실비까지 흡수하면 +{r['gmv'] * 0.034 * free_months:,.0f}, "
                  f"같은 기간 고정비 최소 {FIXED_MIN * free_months:,.0f} / 표준 {FIXED_STD * free_months:,.0f}")

    print("\n--- 사업자가 Pro(수수료 3%p 인하)로 아끼는 금액")
    for s in SCENARIOS:
        r = scenario(*s)
        new_gmv_per_seller = r["gmv"] * s[7][0] / r["sellers"]
        print(f"  {r['name']}: 사업자당 마켓 신규 GMV 월 {new_gmv_per_seller:,.0f} → 3%p = {new_gmv_per_seller * 0.03:,.0f}")

    print("\n--- 대전 전문 사업자 시장 규모 추정")
    for label, sessions, seats, price in (("저", 6, 14, 38_000), ("중", 10, 16, 41_000), ("고", 16, 20, 43_000)):
        weekly = sessions * seats
        print(f"  {label}: 주 {weekly}석, 주 {weekly * price:,}원, 월 {weekly * price * WEEKS_PER_MONTH:,.0f}원")
